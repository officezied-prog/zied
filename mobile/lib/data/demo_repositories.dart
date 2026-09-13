import 'dart:async';
import 'dart:math' as math;
import 'dart:typed_data';

import '../models/models.dart';
import 'repositories.dart';

/// A fixed wardrobe that behaves like the real one.
///
/// These repositories replace only the transport: the screens, the state
/// machines and the models are the production ones. Scores and rationales are
/// copied from a real run of the styling engine rather than invented, so what
/// the demo shows is what the engine actually produces.
class DemoData {
  DemoData._();

  static Garment _g(
    String id,
    String name,
    String category,
    String role,
    String hex,
    String family, {
    int formality = 3,
    int warmth = 1,
    String pattern = 'solid',
    List<String> material = const ['cotton'],
    String? brand,
    int wearCount = 0,
    bool verified = true,
    bool laundry = false,
  }) =>
      Garment(
        id: id,
        category: category,
        categoryId: 1,
        role: role,
        name: name,
        brand: brand,
        pattern: pattern,
        material: material,
        formality: formality,
        warmth: warmth,
        seasons: const ['all_season'],
        colors: [
          GarmentColor(hex: hex, ratio: 0.86, family: family, isNeutral: true),
        ],
        wearCount: wearCount,
        inLaundry: laundry,
        autoTagged: !verified,
        userVerified: verified,
        tagConfidence: verified ? null : 0.74,
      );

  static final List<Garment> wardrobe = [
    _g('g01', 'Navy linen shirt', 'shirt', 'base_top', '#1B2A4A', 'navy',
        formality: 4, material: ['linen'], brand: 'Uniqlo', wearCount: 6,),
    _g('g02', 'White cotton tee', 't_shirt', 'base_top', '#F7F7F7', 'white',
        formality: 2, wearCount: 21,),
    _g('g03', 'Burgundy silk blouse', 'blouse', 'base_top', '#6E1B2E', 'burgundy',
        formality: 4, material: ['silk'], wearCount: 2,),
    _g('g04', 'Grey hoodie', 'hoodie', 'base_top', '#9AA0A6', 'grey',
        formality: 1, warmth: 3, wearCount: 14, laundry: true,),
    _g('g05', 'Camel chinos', 'chinos', 'bottom', '#B08245', 'camel',
        formality: 3, warmth: 2, wearCount: 9,),
    _g('g06', 'Charcoal wool trousers', 'tailored_trousers', 'bottom', '#36393F',
        'charcoal', formality: 5, warmth: 2, material: ['wool'], wearCount: 4,),
    _g('g07', 'Indigo jeans', 'jeans', 'bottom', '#4A6FA5', 'denim',
        formality: 2, warmth: 2, material: ['denim'], wearCount: 31,),
    _g('g08', 'Black cocktail dress', 'cocktail_dress', 'full_body', '#111111',
        'black', formality: 5, material: ['silk'],),
    _g('g09', 'Brown leather derbies', 'dress_shoes', 'footwear', '#6B4A2F',
        'brown', formality: 5, material: ['leather'], wearCount: 12,),
    _g('g10', 'White leather sneakers', 'minimal_sneakers', 'footwear', '#FFFFFF',
        'white', formality: 3, material: ['leather'], wearCount: 40,),
    _g('g11', 'Suede sandals', 'sandals', 'footwear', '#C08A4A', 'camel',
        formality: 2, warmth: 0, material: ['suede'], verified: false,),
    _g('g12', 'Navy wool blazer', 'blazer', 'outerwear', '#1B2A4A', 'navy',
        formality: 5, warmth: 2, material: ['wool'], wearCount: 3,),
    _g('g13', 'Charcoal puffer', 'puffer', 'outerwear', '#36393F', 'charcoal',
        formality: 2, warmth: 5, material: ['nylon'],),
    _g('g14', 'Tan leather belt', 'belt', 'belt', '#B08245', 'camel',
        formality: 3, warmth: 0, material: ['leather'], wearCount: 18,),
  ];

  static Garment byId(String id) => wardrobe.firstWhere((g) => g.id == id);

  static final List<Occasion> occasions = [
    const Occasion(id: 1, slug: 'date_night', displayName: 'Date Night',
        formalityMin: 3, formalityMax: 5,),
    const Occasion(id: 2, slug: 'business_meeting', displayName: 'Business Meeting',
        formalityMin: 4, formalityMax: 5,),
    const Occasion(id: 3, slug: 'casual_gathering', displayName: 'Casual Gathering',
        formalityMin: 2, formalityMax: 3,),
    const Occasion(id: 4, slug: 'formal_event', displayName: 'Formal Event',
        formalityMin: 5, formalityMax: 5,),
    const Occasion(id: 5, slug: 'brunch', displayName: 'Brunch',
        formalityMin: 2, formalityMax: 4,),
    const Occasion(id: 6, slug: 'night_out', displayName: 'Night Out',
        formalityMin: 3, formalityMax: 5,),
    const Occasion(id: 7, slug: 'travel_day', displayName: 'Travel Day',
        formalityMin: 1, formalityMax: 3,),
    const Occasion(id: 8, slug: 'workout', displayName: 'Workout',
        formalityMin: 1, formalityMax: 2,),
    const Occasion(id: 9, slug: 'conference', displayName: 'Conference',
        formalityMin: 3, formalityMax: 4,),
  ];

  /// Looks, with the score breakdowns a real run produced.
  static List<Outfit> outfitsFor(String occasion) {
    final looks = <String, List<Map<String, Object>>>{
      'business_meeting': [
        {
          'items': ['g01', 'g06', 'g09', 'g12'],
          'score': 0.9142,
          'why': 'Navy linen shirt with the charcoal trousers — a tonal pairing under '
              'the blazer, right weight for 19°C, and you have not worn the blazer in '
              '3 weeks.',
          'terms': {'color_harmony': 0.94, 'formality_fit': 1.0, 'weather_fit': 0.88,
                    'personal_taste': 0.83, 'novelty': 0.79, 'pattern_balance': 0.85,},
        },
        {
          'items': ['g01', 'g05', 'g09'],
          'score': 0.8710,
          'why': 'Navy with camel — the complementary pairing the engine rates highest, '
              'pitched right for a business meeting.',
          'terms': {'color_harmony': 0.95, 'formality_fit': 0.95, 'weather_fit': 0.86,
                    'personal_taste': 0.80, 'novelty': 0.62, 'pattern_balance': 0.85,},
        },
      ],
      'date_night': [
        {
          'items': ['g08', 'g09'],
          'score': 0.8934,
          'why': 'The black dress, unworn so far this season, with the brown derbies — '
              'high contrast without competing.',
          'terms': {'color_harmony': 0.88, 'formality_fit': 1.0, 'weather_fit': 0.79,
                    'personal_taste': 0.86, 'novelty': 1.0, 'pattern_balance': 0.85,},
        },
        {
          'items': ['g03', 'g06', 'g09'],
          'score': 0.8521,
          'why': 'Burgundy silk against charcoal — a rich, low-contrast evening pairing, '
              'and the blouse has barely been out.',
          'terms': {'color_harmony': 0.86, 'formality_fit': 1.0, 'weather_fit': 0.82,
                    'personal_taste': 0.78, 'novelty': 0.93, 'pattern_balance': 0.85,},
        },
      ],
      'casual_gathering': [
        {
          'items': ['g02', 'g07', 'g10'],
          'score': 0.8388,
          'why': 'White tee with indigo jeans and the white sneakers — a neutral anchor, '
              'light enough for 24°C.',
          'terms': {'color_harmony': 0.93, 'formality_fit': 1.0, 'weather_fit': 0.91,
                    'personal_taste': 0.71, 'novelty': 0.28, 'pattern_balance': 0.85,},
        },
        {
          'items': ['g01', 'g07', 'g10'],
          'score': 0.8065,
          'why': 'Navy shirt over indigo — a tonal denim look, dressed down by the '
              'sneakers.',
          'terms': {'color_harmony': 0.80, 'formality_fit': 0.75, 'weather_fit': 0.89,
                    'personal_taste': 0.77, 'novelty': 0.55, 'pattern_balance': 0.85,},
        },
      ],
    };

    final chosen = looks[occasion] ?? looks['casual_gathering']!;
    var n = 0;
    return chosen.map((look) {
      final ids = (look['items']! as List).cast<String>();
      return Outfit(
        id: '$occasion-${n++}',
        origin: 'ai',
        occasion: occasion,
        totalScore: look['score']! as double,
        scoreBreakdown: (look['terms']! as Map).cast<String, double>(),
        rationale: look['why']! as String,
        formality: 4,
        dominantColors: ids.map((i) => byId(i).primaryColor?.hex ?? '#000000').toList(),
        items: ids
            .map((i) => OutfitItem(role: byId(i).role, layerOrder: 0, garment: byId(i)))
            .toList(),
        createdAt: DateTime.now(),
      );
    }).toList();
  }
}

// ── repositories ────────────────────────────────────────────────────────────

Future<T> _latency<T>(T value, [int ms = 260]) =>
    Future<T>.delayed(Duration(milliseconds: ms), () => value);

class DemoWardrobeRepository implements WardrobeRepository {
  final List<Garment> _items = [...DemoData.wardrobe];
  final List<DetectionCard> _review = [
    const DetectionCard(
      id: 'd1', label: 'long_sleeved_outwear', confidence: 0.52,
      suggestedCategory: 'Jacket', suggestedCategoryId: 22,
      gateFailures: ['low_confidence'],
    ),
    const DetectionCard(
      id: 'd2', label: 'sling_dress', confidence: 0.41,
      suggestedCategory: 'Dress', suggestedCategoryId: 16,
      gateFailures: ['too_small'],
    ),
  ];

  @override
  Future<({List<Garment> items, String? nextCursor})> list({
    String? role, String? category, String? colorFamily, String? query,
    bool availableOnly = false, String? cursor, int limit = 50,
  }) {
    var out = _items.where((g) {
      if (role != null && g.role != role) return false;
      if (colorFamily != null && !g.colors.any((c) => c.family == colorFamily)) return false;
      if (availableOnly && g.inLaundry) return false;
      if (query != null && query.isNotEmpty) {
        final q = query.toLowerCase();
        return (g.name ?? '').toLowerCase().contains(q) ||
            (g.brand ?? '').toLowerCase().contains(q);
      }
      return true;
    }).toList();
    out = out.take(limit).toList();
    return _latency((items: out, nextCursor: null));
  }

  @override
  Future<Garment> get(String id) => _latency(_items.firstWhere((g) => g.id == id));

  @override
  Future<Garment> update(String id, Map<String, dynamic> patch) {
    final index = _items.indexWhere((g) => g.id == id);
    final current = _items[index];
    final updated = Garment(
      id: current.id, category: current.category, categoryId: current.categoryId,
      role: current.role,
      name: (patch['name'] as String?) ?? current.name,
      brand: (patch['brand'] as String?) ?? current.brand,
      pattern: current.pattern, material: current.material,
      formality: (patch['formality'] as int?) ?? current.formality,
      warmth: current.warmth, seasons: current.seasons, colors: current.colors,
      wearCount: current.wearCount,
      inLaundry: (patch['in_laundry'] as bool?) ?? current.inLaundry,
      autoTagged: current.autoTagged, userVerified: true,
      lastWornAt: current.lastWornAt, tagConfidence: current.tagConfidence,
    );
    _items[index] = updated;
    return _latency(updated, 120);
  }

  @override
  Future<int> bulkUpdate(List<String> ids, Map<String, dynamic> patch) async {
    for (final id in ids) {
      await update(id, patch);
    }
    return ids.length;
  }

  @override
  Future<void> delete(String id) {
    _items.removeWhere((g) => g.id == id);
    return _latency(null, 120);
  }

  @override
  Future<void> logWear(String id) {
    final index = _items.indexWhere((g) => g.id == id);
    final c = _items[index];
    _items[index] = Garment(
      id: c.id, category: c.category, categoryId: c.categoryId, role: c.role,
      name: c.name, brand: c.brand, pattern: c.pattern, material: c.material,
      formality: c.formality, warmth: c.warmth, seasons: c.seasons, colors: c.colors,
      wearCount: c.wearCount + 1, inLaundry: c.inLaundry, autoTagged: c.autoTagged,
      userVerified: c.userVerified, lastWornAt: DateTime.now(),
      tagConfidence: c.tagConfidence,
    );
    return _latency(null, 120);
  }

  @override
  Future<WardrobeStats> stats() {
    final byRole = <String, int>{};
    for (final g in _items) {
      byRole[g.role] = (byRole[g.role] ?? 0) + 1;
    }
    return _latency(WardrobeStats(
      items: _items.length,
      neverWorn: _items.where((g) => g.wearCount == 0).length,
      wornLast30d: _items.where((g) => g.lastWornAt != null).length,
      byRole: byRole,
      gaps: const [],
      avgCostPerWear: 4.20,
    ),);
  }

  @override
  Future<List<DetectionCard>> reviewQueue({int limit = 50}) => _latency([..._review]);

  @override
  Future<void> acceptDetection(String id, {Map<String, dynamic>? corrections}) {
    _review.removeWhere((d) => d.id == id);
    return _latency(null, 150);
  }

  @override
  Future<void> rejectDetection(String id) {
    _review.removeWhere((d) => d.id == id);
    return _latency(null, 150);
  }
}

class DemoStylingRepository implements StylingRepository {
  final Map<String, Outfit> _saved = {};

  @override
  Future<List<Occasion>> occasions() => _latency(DemoData.occasions);

  @override
  Future<Weather> weather(double lat, double lon) =>
      _latency(const Weather(tempC: 24, feelsLikeC: 25, precipProb: 0.05,
          condition: 'clear',),);

  @override
  Future<Recommendation> recommend({
    required String occasion, double? lat, double? lon, Weather? weatherOverride,
    int count = 5, List<String> mustInclude = const [],
    List<String> exclude = const [],
  }) {
    final outfits = DemoData.outfitsFor(occasion)
        .where((o) => !o.items.any((i) => exclude.contains(i.garment.id)))
        .take(count)
        .toList();
    for (final o in outfits) {
      _saved[o.id] = o;
    }
    return _latency(
      Recommendation(
        runId: 'demo-run',
        engineVersion: 'styling-1.0.0',
        outfits: outfits,
        candidateCount: DemoData.wardrobe.length,
        latencyMs: 640,
        weather: weatherOverride ??
            const Weather(tempC: 24, feelsLikeC: 25, precipProb: 0.05, condition: 'clear'),
      ),
      700,
    );
  }

  @override
  Future<List<Outfit>> saved({bool? favorite}) => _latency(
        _saved.values.where((o) => favorite == null || o.isFavorite == favorite).toList(),
      );

  @override
  Future<Outfit> get(String id) => _latency(
        _saved[id] ?? DemoData.outfitsFor('casual_gathering').first,
      );

  @override
  Future<Outfit> setFavorite(String id, {required bool value}) async {
    final o = await get(id);
    final updated = Outfit(
      id: o.id, origin: o.origin, items: o.items, createdAt: o.createdAt,
      name: o.name, occasion: o.occasion, totalScore: o.totalScore,
      scoreBreakdown: o.scoreBreakdown, rationale: o.rationale,
      formality: o.formality, dominantColors: o.dominantColors, isFavorite: value,
    );
    _saved[id] = updated;
    return updated;
  }

  @override
  Future<void> feedback(String outfitId, String kind, {String? reason}) =>
      _latency(null, 200);

  @override
  Future<List<({Garment garment, double score})>> alternatives(
      String outfitId, String role, {List<String> exclude = const [],}) {
    final options = DemoData.wardrobe
        .where((g) => g.role == role && !exclude.contains(g.id))
        .toList();
    var score = 0.84;
    return _latency([
      for (final g in options) (garment: g, score: score -= 0.07),
    ], 400,);
  }
}

class DemoTryOnRepository implements TryOnRepository {
  final List<BodyPhoto> _photos = [];
  int _renders = 0;

  @override
  Future<List<BodyPhoto>> bodyPhotos() => _latency([..._photos]);

  @override
  Future<BodyPhoto> registerBodyPhoto(String mediaId, {String pose = 'front_full'}) {
    final photo = BodyPhoto(
      id: 'photo-${_photos.length}', pose: pose, isPrimary: true,
      status: 'succeeded', qualityScore: 0.92,
    );
    _photos.add(photo);
    return _latency(photo, 500);
  }

  @override
  Future<void> deleteBodyPhoto(String id) {
    _photos.removeWhere((p) => p.id == id);
    return _latency(null, 200);
  }

  @override
  Future<TryOnJob> start({
    String? outfitId, List<String> garmentIds = const [], String? bodyPhotoId,
    String? modelId, String? idempotencyKey,
  }) =>
      _latency(TryOnJob(
        id: 'render-${_renders++}', status: 'running', modelId: 'composite@1',
        queuedAt: DateTime.now(), passIndex: 1, totalPasses: 3, pollAfterMs: 900,
      ),);

  @override
  Future<TryOnJob> awaitResult(String jobId, {void Function(TryOnJob)? onTick}) async {
    for (var pass = 2; pass <= 3; pass++) {
      await Future<void>.delayed(const Duration(milliseconds: 900));
      onTick?.call(TryOnJob(
        id: jobId, status: 'running', modelId: 'composite@1',
        queuedAt: DateTime.now(), passIndex: pass, totalPasses: 3,
      ),);
    }
    await Future<void>.delayed(const Duration(milliseconds: 700));
    return TryOnJob(
      id: jobId, status: 'succeeded', modelId: 'composite@1',
      queuedAt: DateTime.now(), passIndex: 3, totalPasses: 3, pollAfterMs: 0,
    );
  }

  @override
  Future<void> cancel(String jobId) => _latency(null, 150);
}

class DemoAccountRepository implements AccountRepository {
  final Map<String, bool> _consents = {
    'terms_of_service': true,
    'biometric_processing': false,
    'vton_processing': false,
    'social_ingest': false,
    'model_training': false,
  };

  @override
  Future<Map<String, bool>> consents() => _latency({..._consents});

  @override
  Future<void> setConsent(String type, {required bool granted}) {
    _consents[type] = granted;
    return _latency(null, 150);
  }

  @override
  Future<Map<String, dynamic>> me() => _latency({
        'id': '00000000-0000-4000-8000-000000000001',
        'display_name': 'Demo',
        'units': 'metric',
      });
}

class DemoUploadRepository implements UploadRepository {
  final _random = math.Random(7);

  @override
  Future<List<String>> uploadImages(
    List<Uint8List> images, {
    String purpose = 'wardrobe',
    List<String>? filenames,
    void Function(int done, int total)? onProgress,
  }) async {
    for (var i = 0; i < images.length; i++) {
      await Future<void>.delayed(const Duration(milliseconds: 220));
      onProgress?.call(i + 1, images.length);
    }
    return List.generate(images.length, (i) => 'demo-media-$i');
  }

  @override
  Future<IngestJob> startIngest(List<String> mediaIds,
          {bool autoAccept = true, String? idempotencyKey,}) =>
      _latency(IngestJob(
        id: 'demo-ingest', status: 'queued', itemsDiscovered: mediaIds.length,
        itemsProcessed: 0, garmentsCreated: 0, needsReview: 0,
      ),);

  @override
  Future<IngestJob> awaitIngest(String jobId,
      {void Function(IngestJob job)? onTick,}) async {
    const total = 3;
    for (var done = 1; done <= total; done++) {
      await Future<void>.delayed(const Duration(milliseconds: 700));
      onTick?.call(IngestJob(
        id: jobId, status: 'running', itemsDiscovered: total, itemsProcessed: done,
        garmentsCreated: done * 2, needsReview: done ~/ 2,
      ),);
    }
    return IngestJob(
      id: jobId, status: 'succeeded', itemsDiscovered: total, itemsProcessed: total,
      garmentsCreated: 6 + _random.nextInt(2), needsReview: 1,
    );
  }
}
