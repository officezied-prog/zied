import 'package:flutter_test/flutter_test.dart';
import 'package:smartstylist/core/color_math.dart';
import 'package:smartstylist/data/demo_repositories.dart';
import 'package:smartstylist/data/demo_shop.dart';
import 'package:smartstylist/models/models.dart';

Garment _g(String id, String name, String category, String role, String hex,
    String family, {int formality = 3,}) =>
    Garment(
      id: id,
      category: category,
      categoryId: 1,
      role: role,
      name: name,
      formality: formality,
      warmth: 1,
      colors: [GarmentColor(hex: hex, ratio: 1, family: family, isNeutral: true)],
      wearCount: 0,
      inLaundry: false,
      autoTagged: false,
      userVerified: true,
    );

void main() {
  group('duplicate detection', () {
    test('a near-identical navy shirt is reported as one already owned', () {
      const rack = RackItem(id: 'x', name: 'Navy poplin shirt', category: 'shirt',
          role: 'base_top', hex: '#1D2C4C', family: 'navy', formality: 4,);
      final wardrobe = [
        _g('a', 'Navy linen shirt', 'shirt', 'base_top', '#1B2A4A', 'navy'),
        _g('b', 'White tee', 't_shirt', 'base_top', '#F7F7F7', 'white'),
      ];

      final result = judge(rack, wardrobe);
      expect(result.duplicates, hasLength(1));
      expect(result.duplicates.single.name, 'Navy linen shirt');
      expect(result.duplicates.single.deltaE, lessThan(duplicateDeltaE));
      expect(result.verdict, ScanVerdict.haveSimilar);
    });

    test('the same colour in a different category is not a duplicate', () {
      const rack = RackItem(id: 'x', name: 'Navy trousers',
          category: 'tailored_trousers', role: 'bottom', hex: '#1B2A4A',
          family: 'navy', formality: 4,);
      final wardrobe = [
        _g('a', 'Navy linen shirt', 'shirt', 'base_top', '#1B2A4A', 'navy'),
      ];
      expect(judge(rack, wardrobe).duplicates, isEmpty);
    });

    test('a colour a person would call different is not a duplicate', () {
      const rack = RackItem(id: 'x', name: 'Burgundy shirt', category: 'shirt',
          role: 'base_top', hex: '#6E1B2E', family: 'burgundy',);
      final wardrobe = [
        _g('a', 'Navy shirt', 'shirt', 'base_top', '#1B2A4A', 'navy'),
      ];
      expect(judge(rack, wardrobe).duplicates, isEmpty);
    });
  });

  group('saturation', () {
    test('a colour that owns its role is flagged without an exact duplicate', () {
      const rack = RackItem(id: 'x', name: 'Navy chinos', category: 'chinos',
          role: 'bottom', hex: '#1B2A4A', family: 'navy',);
      final wardrobe = [
        _g('a', 'Navy jeans', 'jeans', 'bottom', '#1B2A4A', 'navy'),
        _g('b', 'Navy cords', 'trousers', 'bottom', '#1D2C4C', 'navy'),
        _g('c', 'White shirt', 'shirt', 'base_top', '#F7F7F7', 'white'),
      ];

      final result = judge(rack, wardrobe);
      expect(result.duplicates, isEmpty);
      expect(result.verdict, ScanVerdict.haveSimilar);
      expect(result.detail, contains('100% are already navy'));
    });

    test('owning navy elsewhere says nothing about a navy bottom', () {
      const rack = RackItem(id: 'x', name: 'Navy chinos', category: 'chinos',
          role: 'bottom', hex: '#1B2A4A', family: 'navy',);
      final wardrobe = [
        _g('a', 'Navy shirt', 'shirt', 'base_top', '#1B2A4A', 'navy'),
        _g('b', 'Navy blazer', 'blazer', 'outerwear', '#1B2A4A', 'navy'),
        _g('c', 'Camel chinos', 'chinos', 'bottom', '#B08245', 'camel'),
      ];
      expect(judge(rack, wardrobe).verdict, isNot(ScanVerdict.haveSimilar));
    });
  });

  group('the outfit it would join', () {
    test('names pieces at home and never two of the same role', () {
      const rack = RackItem(id: 'x', name: 'Camel chinos', category: 'chinos',
          role: 'bottom', hex: '#B08245', family: 'camel',);
      final wardrobe = [
        _g('a', 'Navy shirt', 'shirt', 'base_top', '#1B2A4A', 'navy'),
        _g('b', 'White tee', 't_shirt', 'base_top', '#F7F7F7', 'white'),
        _g('c', 'Brown derbies', 'dress_shoes', 'footwear', '#6B4A2F', 'brown'),
      ];

      final result = judge(rack, wardrobe);
      final roles = result.wearWith.map((w) => w.role).toList();
      expect(roles.toSet(), hasLength(roles.length));
      expect(result.wearWith.length, lessThanOrEqualTo(3));
      expect(result.detail, contains('Wear it with your'));
    });

    test('is ordered the way the clothes are worn', () {
      const rack = RackItem(id: 'x', name: 'Navy chinos', category: 'chinos',
          role: 'bottom', hex: '#1B2A4A', family: 'navy',);
      final wardrobe = [
        _g('c', 'Camel sandals', 'sandals', 'footwear', '#B08245', 'camel'),
        _g('a', 'White shirt', 'shirt', 'base_top', '#F7F7F7', 'white'),
      ];
      final roles = judge(rack, wardrobe).wearWith.map((w) => w.role).toList();
      expect(roles, ['base_top', 'footwear']);
    });

    test('a merely-safe neutral pair counts as wearable but is not the outfit', () {
      // camel + brown is two warm neutrals with no curated rule, so the
      // fallback scores it 0.65: wearable, but not worth naming as a look.
      const rack = RackItem(id: 'x', name: 'Camel chinos', category: 'chinos',
          role: 'bottom', hex: '#B08245', family: 'camel',);
      final wardrobe = [
        _g('c', 'Brown derbies', 'dress_shoes', 'footwear', '#6B4A2F', 'brown'),
      ];
      final result = judge(rack, wardrobe);
      expect(result.wearWith, isEmpty);
      expect(result.newPairings, 1);
      expect(result.verdict, ScanVerdict.addsVariety);
    });

    test('a neutral that goes with everything is not called hard to wear', () {
      // Found by reading real demo output: an olive jacket read as "works with
      // 0 of 11" against a wardrobe of navy, grey and camel.
      const rack = RackItem(id: 'x', name: 'Olive field jacket',
          category: 'blazer', role: 'outerwear', hex: '#6B7238',
          family: 'olive',);
      final wardrobe = [
        _g('a', 'Navy shirt', 'shirt', 'base_top', '#1B2A4A', 'navy'),
        _g('b', 'Grey shirt', 'shirt', 'base_top', '#9AA0A6', 'grey'),
        _g('c', 'Brown derbies', 'dress_shoes', 'footwear', '#6B4A2F', 'brown'),
      ];
      final result = judge(rack, wardrobe);
      expect(result.newPairings, result.totalComplements);
      expect(result.verdict, isNot(ScanVerdict.hardToWear));
    });

    test('leaves out pieces it clashes with', () {
      const rack = RackItem(id: 'x', name: 'Red trousers', category: 'chinos',
          role: 'bottom', hex: '#DC2626', family: 'red',);
      final wardrobe = [
        _g('a', 'Green shirt', 'shirt', 'base_top', '#16A34A', 'green'),
      ];
      final result = judge(rack, wardrobe);
      expect(result.wearWith, isEmpty);          // red/green scores 0.25
      expect(result.newPairings, 0);
      expect(result.verdict, ScanVerdict.hardToWear);
    });
  });

  group('pairings are counted against complementary roles only', () {
    test('trousers are judged against tops and shoes, never other trousers', () {
      const rack = RackItem(id: 'x', name: 'Camel chinos', category: 'chinos',
          role: 'bottom', hex: '#B08245', family: 'camel',);
      final wardrobe = [
        _g('a', 'Navy shirt', 'shirt', 'base_top', '#1B2A4A', 'navy'),
        _g('b', 'Grey trousers', 'trousers', 'bottom', '#9AA0A6', 'grey'),
        _g('c', 'Black trousers', 'trousers', 'bottom', '#111111', 'black'),
      ];
      expect(judge(rack, wardrobe).totalComplements, 1);
    });
  });

  group('what to look for instead', () {
    test('a duplicate is told which colours and shapes are missing', () {
      const rack = RackItem(id: 'x', name: 'Navy shirt', category: 'shirt',
          role: 'base_top', hex: '#1B2A4A', family: 'navy',);
      final wardrobe = [
        _g('a', 'Navy shirt', 'shirt', 'base_top', '#1B2A4A', 'navy'),
        _g('b', 'Navy tee', 't_shirt', 'base_top', '#1D2C4C', 'navy'),
      ];

      final result = judge(rack, wardrobe);
      expect(result.lookForColors, isNotEmpty);
      expect(result.lookForColors.map((c) => c.family), isNot(contains('navy')));
      expect(result.lookForRoles, isNotEmpty);
      expect(result.detail, contains('What you are short of'));
    });

    test('a good buy is not handed a shopping list', () {
      const rack = RackItem(id: 'x', name: 'Camel chinos', category: 'chinos',
          role: 'bottom', hex: '#B08245', family: 'camel',);
      final wardrobe = [
        _g('a', 'Navy shirt', 'shirt', 'base_top', '#1B2A4A', 'navy'),
        _g('b', 'White tee', 't_shirt', 'base_top', '#F7F7F7', 'white'),
      ];
      final result = judge(rack, wardrobe);
      expect(result.verdict, ScanVerdict.addsVariety);
      expect(result.lookForColors, isEmpty);
      expect(result.lookForRoles, isEmpty);
    });
  });

  group('colour pairing follows the server rules', () {
    test('the curated table wins over hue geometry', () {
      expect(
        pairScore('navy', 'camel', hexToLab('#1B2A4A'), hexToLab('#B08245')),
        0.95,
      );
      expect(
        pairScore('red', 'green', hexToLab('#DC2626'), hexToLab('#16A34A')),
        0.25,
      );
    });

    test('a neutral anchors anything not in the table', () {
      expect(
        pairScore('charcoal', 'teal', hexToLab('#36393F'), hexToLab('#0F766E')),
        0.65,
      );
    });

    test('two hero colours in the awkward middle are penalised', () {
      final score = pairScore('purple', 'coral',
          hexToLab('#7C3AED'), hexToLab('#FF7F6B'),);
      expect(score, lessThan(0.70));
    });
  });

  group('the demo repository', () {
    test('every item on the rail can be judged', () async {
      final repo = DemoShopRepository();
      for (final item in demoRack) {
        final result = await repo.scan(item.id);
        expect(result.headline, isNotEmpty);
        expect(result.detail, isNotEmpty);
        expect(result.category, item.category);
      }
    });

    test('buying it files it, and the next scan counts it as owned', () async {
      final repo = DemoShopRepository();
      final before = DemoData.wardrobe.length;

      final first = await repo.scan('r4');       // cream trousers, nothing like it
      expect(first.duplicates, isEmpty);
      await repo.markBought(first.scanId);
      expect(DemoData.wardrobe.length, before + 1);

      final second = await repo.scan('r4');
      expect(second.duplicates, hasLength(1));
      expect(second.verdict, ScanVerdict.haveSimilar);

      DemoData.wardrobe.removeRange(before, DemoData.wardrobe.length);
    });

    test('a scan stays open until it is decided on', () async {
      final repo = DemoShopRepository();
      final scan = await repo.scan('r1');
      expect(await repo.openScans(), hasLength(1));
      await repo.dismiss(scan.scanId);
      expect(await repo.openScans(), isEmpty);
    });
  });
}
