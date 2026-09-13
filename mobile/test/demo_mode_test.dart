import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:smartstylist/data/demo_repositories.dart';
import 'package:smartstylist/models/models.dart';

/// Demo mode is what someone sees when they open the app without a backend —
/// a browser build, a design review, store screenshots. If it silently returns
/// nothing, the app looks broken to exactly the audience it exists for.
void main() {
  group('sample wardrobe', () {
    test('covers every role an outfit needs', () {
      final roles = DemoData.wardrobe.map((g) => g.role).toSet();
      expect(roles, containsAll(['base_top', 'bottom', 'footwear']));
      expect(roles, contains('full_body'));
      expect(roles, contains('outerwear'));
    });

    test('every piece carries a colour the UI can draw', () {
      for (final g in DemoData.wardrobe) {
        expect(g.primaryColor, isNotNull, reason: '${g.name} has no colour');
        expect(g.primaryColor!.hex, matches(RegExp(r'^#[0-9A-Fa-f]{6}$')));
        expect(g.displayName, isNotEmpty);
      }
    });

    test('includes an unverified item so the review affordance is visible', () {
      expect(DemoData.wardrobe.any((g) => g.needsConfirmation), isTrue);
      expect(DemoData.wardrobe.any((g) => g.inLaundry), isTrue);
    });
  });

  group('DemoWardrobeRepository', () {
    test('filters by role, colour and availability', () async {
      final repo = DemoWardrobeRepository();

      final tops = await repo.list(role: 'base_top');
      expect(tops.items, isNotEmpty);
      expect(tops.items.every((g) => g.role == 'base_top'), isTrue);

      final navy = await repo.list(colorFamily: 'navy');
      expect(navy.items, isNotEmpty);
      expect(
        navy.items.every((g) => g.colors.any((c) => c.family == 'navy')),
        isTrue,
      );

      final available = await repo.list(availableOnly: true);
      expect(available.items.any((g) => g.inLaundry), isFalse);
    });

    test('search matches name and brand', () async {
      final repo = DemoWardrobeRepository();
      expect((await repo.list(query: 'linen')).items, isNotEmpty);
      expect((await repo.list(query: 'uniqlo')).items, isNotEmpty);
      expect((await repo.list(query: 'zzzz')).items, isEmpty);
    });

    test('editing marks the item verified, as the real API does', () async {
      final repo = DemoWardrobeRepository();
      final before = await repo.get('g11');
      expect(before.userVerified, isFalse);

      final after = await repo.update('g11', {'brand': 'COS'});
      expect(after.brand, 'COS');
      expect(after.userVerified, isTrue);
    });

    test('logging a wear increments the counter', () async {
      final repo = DemoWardrobeRepository();
      final before = (await repo.get('g01')).wearCount;
      await repo.logWear('g01');
      expect((await repo.get('g01')).wearCount, before + 1);
    });

    test('accepting a review card removes it from the queue', () async {
      final repo = DemoWardrobeRepository();
      final queue = await repo.reviewQueue();
      expect(queue, isNotEmpty);
      await repo.acceptDetection(queue.first.id);
      expect((await repo.reviewQueue()).length, queue.length - 1);
    });

    test('stats agree with the wardrobe', () async {
      final repo = DemoWardrobeRepository();
      final stats = await repo.stats();
      final items = (await repo.list()).items;
      expect(stats.items, items.length);
      expect(stats.byRole.values.fold<int>(0, (a, b) => a + b), items.length);
    });
  });

  group('DemoStylingRepository', () {
    test('returns complete, scored, explained outfits', () async {
      final repo = DemoStylingRepository();
      for (final occasion in ['business_meeting', 'date_night', 'casual_gathering']) {
        final result = await repo.recommend(occasion: occasion);
        expect(result.outfits, isNotEmpty, reason: occasion);

        for (final outfit in result.outfits) {
          final roles = outfit.items.map((i) => i.role).toSet();
          expect(roles, contains('footwear'), reason: 'every look needs shoes');
          expect(
            roles.contains('full_body') ||
                (roles.contains('base_top') && roles.contains('bottom')),
            isTrue,
          );
          expect(outfit.totalScore, inInclusiveRange(0, 1));
          expect(outfit.rationale, isNotNull);
          expect(outfit.rationale, isNotEmpty);
          expect(outfit.topReasons.length, 2);
        }
      }
    });

    test('honours exclusions', () async {
      final repo = DemoStylingRepository();
      final result = await repo.recommend(occasion: 'date_night', exclude: ['g08']);
      final used = result.outfits.expand((o) => o.items.map((i) => i.garment.id));
      expect(used, isNot(contains('g08')));
    });

    test('offers alternatives for a slot, best first', () async {
      final repo = DemoStylingRepository();
      final options = await repo.alternatives('x', 'footwear', exclude: ['g09']);
      expect(options, isNotEmpty);
      expect(options.every((o) => o.garment.role == 'footwear'), isTrue);
      expect(options.map((o) => o.garment.id), isNot(contains('g09')));

      final scores = options.map((o) => o.score).toList();
      final sorted = [...scores]..sort((a, b) => b.compareTo(a));
      expect(scores, sorted);
    });

    test('favouriting survives a re-read', () async {
      final repo = DemoStylingRepository();
      final first = (await repo.recommend(occasion: 'brunch')).outfits.first;
      await repo.setFavorite(first.id, value: true);
      expect((await repo.get(first.id)).isFavorite, isTrue);
      expect((await repo.saved(favorite: true)), isNotEmpty);
    });
  });

  group('DemoTryOnRepository', () {
    test('consent defaults to off, exactly like a new account', () async {
      final account = DemoAccountRepository();
      final consents = await account.consents();
      expect(consents['vton_processing'], isFalse);
      expect(consents['biometric_processing'], isFalse);

      await account.setConsent('vton_processing', granted: true);
      expect((await account.consents())['vton_processing'], isTrue);
    });

    test('a render reports each layer pass and then succeeds', () async {
      final repo = DemoTryOnRepository();
      expect(await repo.bodyPhotos(), isEmpty);

      final photo = await repo.registerBodyPhoto('m1');
      expect(photo.isPrimary, isTrue);
      expect((await repo.bodyPhotos()).length, 1);

      final job = await repo.start(garmentIds: ['g01']);
      expect(job.isRunning, isTrue);

      final passes = <int>[];
      final done = await repo.awaitResult(job.id, onTick: (t) => passes.add(t.passIndex));
      expect(passes, [2, 3]);
      expect(done.status, 'succeeded');
    });

    test('deleting the photo removes it', () async {
      final repo = DemoTryOnRepository();
      final photo = await repo.registerBodyPhoto('m1');
      await repo.deleteBodyPhoto(photo.id);
      expect(await repo.bodyPhotos(), isEmpty);
    });
  });

  group('DemoUploadRepository', () {
    test('reports upload then ingest progress, ending with garments', () async {
      final repo = DemoUploadRepository();
      final uploaded = <int>[];
      final ids = await repo.uploadImages(
        List.generate(3, (_) => Uint8List(0)),
        onProgress: (done, total) => uploaded.add(done),
      );
      expect(ids.length, 3);
      expect(uploaded, [1, 2, 3]);

      final job = await repo.startIngest(ids);
      final ticks = <IngestJob>[];
      final finished = await repo.awaitIngest(job.id, onTick: ticks.add);
      expect(ticks, isNotEmpty);
      expect(finished.status, 'succeeded');
      expect(finished.garmentsCreated, greaterThan(0));
      expect(finished.progress, 1.0);
    });
  });
}
