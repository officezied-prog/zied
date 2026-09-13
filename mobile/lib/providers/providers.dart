import 'dart:typed_data';

import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../core/api_client.dart';
import '../core/config.dart';
import '../data/demo_repositories.dart';
import '../data/repositories.dart';
import '../models/models.dart';

// ── infrastructure ──────────────────────────────────────────────────────────
final sharedPreferencesProvider = Provider<SharedPreferences>(
  (ref) => throw UnimplementedError('overridden in main()'),
);

/// Session token. A real build swaps this for the IdP SDK; the rest of the app
/// does not change, because everything downstream only asks for a bearer token.
class AuthController extends StateNotifier<String?> {
  AuthController(this._prefs) : super(_prefs.getString(_key) ?? _initial());

  static const _key = 'ss.token';
  final SharedPreferences _prefs;

  static String? _initial() =>
      AppConfig.devToken.isEmpty ? null : AppConfig.devToken;

  bool get isSignedIn => state != null && state!.isNotEmpty;

  Future<void> signIn(String token) async {
    await _prefs.setString(_key, token);
    state = token;
  }

  Future<void> signOut() async {
    await _prefs.remove(_key);
    state = null;
  }
}

final authControllerProvider =
    StateNotifierProvider<AuthController, String?>((ref) {
  return AuthController(ref.watch(sharedPreferencesProvider));
});

final apiClientProvider = Provider<ApiClient>((ref) {
  final client = ApiClient(
    tokenProvider: () async => ref.read(authControllerProvider),
    onUnauthorized: () async => ref.read(authControllerProvider.notifier).signOut(),
  );
  ref.onDispose(client.close);
  return client;
});

// In demo mode only the transport changes: the screens, state machines and
// models below are the same objects the shipping app uses.
final uploadRepositoryProvider = Provider<UploadRepository>((ref) =>
    AppConfig.demoMode ? DemoUploadRepository() : UploadRepository(ref.watch(apiClientProvider)),);
final wardrobeRepositoryProvider = Provider<WardrobeRepository>((ref) =>
    AppConfig.demoMode ? DemoWardrobeRepository() : WardrobeRepository(ref.watch(apiClientProvider)),);
final stylingRepositoryProvider = Provider<StylingRepository>((ref) =>
    AppConfig.demoMode ? DemoStylingRepository() : StylingRepository(ref.watch(apiClientProvider)),);
final tryOnRepositoryProvider = Provider<TryOnRepository>((ref) =>
    AppConfig.demoMode ? DemoTryOnRepository() : TryOnRepository(ref.watch(apiClientProvider)),);
final accountRepositoryProvider = Provider<AccountRepository>((ref) =>
    AppConfig.demoMode ? DemoAccountRepository() : AccountRepository(ref.watch(apiClientProvider)),);

// ── wardrobe ────────────────────────────────────────────────────────────────
class WardrobeFilter {
  const WardrobeFilter({this.role, this.colorFamily, this.query, this.availableOnly = false});

  final String? role;
  final String? colorFamily;
  final String? query;
  final bool availableOnly;

  WardrobeFilter copyWith({
    String? role,
    String? colorFamily,
    String? query,
    bool? availableOnly,
    bool clearRole = false,
    bool clearColor = false,
  }) =>
      WardrobeFilter(
        role: clearRole ? null : (role ?? this.role),
        colorFamily: clearColor ? null : (colorFamily ?? this.colorFamily),
        query: query ?? this.query,
        availableOnly: availableOnly ?? this.availableOnly,
      );

  bool get isEmpty =>
      role == null && colorFamily == null && (query ?? '').isEmpty && !availableOnly;
}

final wardrobeFilterProvider =
    StateProvider<WardrobeFilter>((ref) => const WardrobeFilter());

/// The wardrobe grid. Paginated by cursor — a 4 000-item closet must not get
/// slower the further you scroll.
class WardrobeNotifier extends StateNotifier<AsyncValue<List<Garment>>> {
  WardrobeNotifier(this._repo, this._filter) : super(const AsyncValue.loading()) {
    refresh();
  }

  final WardrobeRepository _repo;
  final WardrobeFilter _filter;
  String? _cursor;
  bool _loadingMore = false;

  bool get hasMore => _cursor != null;

  Future<void> refresh() async {
    state = const AsyncValue.loading();
    _cursor = null;
    try {
      final page = await _repo.list(
        role: _filter.role,
        colorFamily: _filter.colorFamily,
        query: _filter.query,
        availableOnly: _filter.availableOnly,
      );
      _cursor = page.nextCursor;
      state = AsyncValue.data(page.items);
    } catch (error, stack) {
      state = AsyncValue.error(error, stack);
    }
  }

  Future<void> loadMore() async {
    if (_loadingMore || _cursor == null) return;
    _loadingMore = true;
    try {
      final page = await _repo.list(
        role: _filter.role,
        colorFamily: _filter.colorFamily,
        query: _filter.query,
        availableOnly: _filter.availableOnly,
        cursor: _cursor,
      );
      _cursor = page.nextCursor;
      state = AsyncValue.data([...state.value ?? const [], ...page.items]);
    } finally {
      _loadingMore = false;
    }
  }

  /// Optimistic toggle: the grid updates immediately and reverts on failure.
  Future<void> toggleLaundry(Garment garment) async {
    final items = [...state.value ?? const <Garment>[]];
    final index = items.indexWhere((g) => g.id == garment.id);
    if (index < 0) return;
    try {
      final updated = await _repo.update(garment.id, {'in_laundry': !garment.inLaundry});
      items[index] = updated;
      state = AsyncValue.data(items);
    } catch (_) {
      await refresh();
      rethrow;
    }
  }

  Future<void> remove(Garment garment) async {
    state = AsyncValue.data(
        [...(state.value ?? const <Garment>[])]..removeWhere((g) => g.id == garment.id),);
    try {
      await _repo.delete(garment.id);
    } catch (_) {
      await refresh();
      rethrow;
    }
  }
}

final wardrobeProvider =
    StateNotifierProvider<WardrobeNotifier, AsyncValue<List<Garment>>>((ref) {
  return WardrobeNotifier(
      ref.watch(wardrobeRepositoryProvider), ref.watch(wardrobeFilterProvider),);
});

final wardrobeStatsProvider = FutureProvider<WardrobeStats>(
    (ref) => ref.watch(wardrobeRepositoryProvider).stats(),);

final reviewQueueProvider = FutureProvider<List<DetectionCard>>(
    (ref) => ref.watch(wardrobeRepositoryProvider).reviewQueue(),);

// ── styling ─────────────────────────────────────────────────────────────────
final occasionsProvider = FutureProvider<List<Occasion>>(
    (ref) => ref.watch(stylingRepositoryProvider).occasions(),);

final selectedOccasionProvider = StateProvider<String?>((ref) => null);

final savedOutfitsProvider = FutureProvider<List<Outfit>>(
    (ref) => ref.watch(stylingRepositoryProvider).saved(),);

/// Holds the last recommendation so the results screen survives rebuilds and a
/// back-navigation does not silently re-run (and re-bill) the engine.
class RecommendationNotifier extends StateNotifier<AsyncValue<Recommendation?>> {
  RecommendationNotifier(this._repo) : super(const AsyncValue.data(null));

  final StylingRepository _repo;

  Future<void> run({
    required String occasion,
    double? lat,
    double? lon,
    Weather? weatherOverride,
    int count = 5,
  }) async {
    state = const AsyncValue.loading();
    try {
      state = AsyncValue.data(await _repo.recommend(
        occasion: occasion,
        lat: lat,
        lon: lon,
        weatherOverride: weatherOverride,
        count: count,
      ),);
    } catch (error, stack) {
      state = AsyncValue.error(error, stack);
    }
  }

  void clear() => state = const AsyncValue.data(null);

  Future<void> feedback(String outfitId, String kind) async {
    await _repo.feedback(outfitId, kind);
  }
}

final recommendationProvider =
    StateNotifierProvider<RecommendationNotifier, AsyncValue<Recommendation?>>(
        (ref) => RecommendationNotifier(ref.watch(stylingRepositoryProvider)),);

final outfitProvider = FutureProvider.family<Outfit, String>(
    (ref, id) => ref.watch(stylingRepositoryProvider).get(id),);

// ── try-on ──────────────────────────────────────────────────────────────────
final bodyPhotosProvider = FutureProvider<List<BodyPhoto>>(
    (ref) => ref.watch(tryOnRepositoryProvider).bodyPhotos(),);

final consentsProvider = FutureProvider<Map<String, bool>>(
    (ref) => ref.watch(accountRepositoryProvider).consents(),);

class TryOnState {
  const TryOnState({this.job, this.error, this.busy = false});

  final TryOnJob? job;
  final Object? error;
  final bool busy;

  TryOnState copyWith({TryOnJob? job, Object? error, bool? busy, bool clearError = false}) =>
      TryOnState(
        job: job ?? this.job,
        error: clearError ? null : (error ?? this.error),
        busy: busy ?? this.busy,
      );
}

class TryOnController extends StateNotifier<TryOnState> {
  TryOnController(this._repo) : super(const TryOnState());

  final TryOnRepository _repo;

  Future<void> render({String? outfitId, List<String> garmentIds = const []}) async {
    state = const TryOnState(busy: true);
    try {
      final started = await _repo.start(outfitId: outfitId, garmentIds: garmentIds);
      state = state.copyWith(job: started);
      if (started.isReady) {
        state = TryOnState(job: started);
        return;
      }
      final done = await _repo.awaitResult(
        started.id,
        onTick: (job) => state = state.copyWith(job: job),
      );
      state = TryOnState(job: done);
    } catch (error) {
      state = TryOnState(error: error, job: state.job);
    }
  }

  Future<void> cancel() async {
    final job = state.job;
    if (job == null) return;
    await _repo.cancel(job.id);
    state = const TryOnState();
  }

  void reset() => state = const TryOnState();
}

final tryOnControllerProvider =
    StateNotifierProvider<TryOnController, TryOnState>(
        (ref) => TryOnController(ref.watch(tryOnRepositoryProvider)),);

// ── import ──────────────────────────────────────────────────────────────────
class ImportProgress {
  const ImportProgress({
    this.uploading = 0,
    this.total = 0,
    this.job,
    this.error,
    this.done = false,
  });

  final int uploading;
  final int total;
  final IngestJob? job;
  final Object? error;
  final bool done;

  bool get isActive => total > 0 && !done && error == null;
  double get fraction {
    if (total == 0) return 0;
    final uploadShare = uploading / total * 0.4;
    return uploadShare + (job?.progress ?? 0) * 0.6;
  }
}

class ImportController extends StateNotifier<ImportProgress> {
  ImportController(this._uploads, this._ref) : super(const ImportProgress());

  final UploadRepository _uploads;
  final Ref _ref;

  Future<void> importPhotos(List<Uint8List> images) async {
    if (images.isEmpty) return;
    state = ImportProgress(total: images.length);
    try {
      final mediaIds = await _uploads.uploadImages(
        images,
        onProgress: (done, total) =>
            state = ImportProgress(uploading: done, total: total),
      );
      final job = await _uploads.startIngest(mediaIds);
      state = ImportProgress(uploading: images.length, total: images.length, job: job);

      final finished = await _uploads.awaitIngest(
        job.id,
        onTick: (tick) => state = ImportProgress(
            uploading: images.length, total: images.length, job: tick,),
      );
      state = ImportProgress(
          uploading: images.length, total: images.length, job: finished, done: true,);

      _ref.invalidate(wardrobeProvider);
      _ref.invalidate(wardrobeStatsProvider);
      _ref.invalidate(reviewQueueProvider);
    } catch (error) {
      state = ImportProgress(total: images.length, error: error);
    }
  }

  void reset() => state = const ImportProgress();
}

final importControllerProvider =
    StateNotifierProvider<ImportController, ImportProgress>(
        (ref) => ImportController(ref.watch(uploadRepositoryProvider), ref),);
