import 'package:flutter_test/flutter_test.dart';
import 'package:smartstylist/core/color_math.dart';

/// Sharma, Wu & Dalal (2005) — the canonical CIEDE2000 test pairs, the same
/// ones `tests/test_color.py` pins the Python and SQL implementations to.
const _sharma = [
  ([50.0000, 2.6772, -79.7751], [50.0000, 0.0000, -82.7485], 2.0425),
  ([50.0000, 2.4900, -0.0010], [50.0000, -2.4900, 0.0009], 7.1792),
  ([50.0000, 2.5000, 0.0000], [50.0000, 0.0000, -2.5000], 4.3065),
  ([60.2574, -34.0099, 36.2677], [60.4626, -34.1751, 39.4387], 1.2644),
  ([22.7233, 20.0904, -46.6940], [23.0331, 14.9730, -42.5619], 2.0373),
  ([2.0776, 0.0795, -1.1350], [0.9033, -0.0636, -0.5514], 0.9082),
];

void main() {
  group('CIEDE2000', () {
    test('matches the reference pairs the backend is pinned to', () {
      for (final (one, two, expected) in _sharma) {
        final delta = ciede2000(
          Lab(one[0], one[1], one[2]),
          Lab(two[0], two[1], two[2]),
        );
        expect(delta, closeTo(expected, 1e-4),
            reason: 'pair $one vs $two',);
      }
    });

    test('is symmetric', () {
      final a = hexToLab('#1B2A4A');
      final b = hexToLab('#B08245');
      expect(ciede2000(a, b), closeTo(ciede2000(b, a), 1e-9));
    });

    test('two navies read as the same colour, navy and camel do not', () {
      expect(ciede2000(hexToLab('#1B2A4A'), hexToLab('#1D2C4C')),
          closeTo(0.6324, 1e-3),);
      expect(ciede2000(hexToLab('#1B2A4A'), hexToLab('#B08245')),
          closeTo(50.1621, 1e-3),);
    });
  });

  group('sRGB to CIELAB', () {
    test('known values', () {
      final white = hexToLab('#FFFFFF');
      expect(white.l, closeTo(100, 1e-3));
      expect(white.a, closeTo(0, 1e-3));
      expect(white.b, closeTo(0, 1e-3));

      final black = hexToLab('#000000');
      expect(black.l, closeTo(0, 1e-6));

      final red = hexToLab('#FF0000');
      expect(red.l, closeTo(53.2408, 1e-3));
      expect(red.a, closeTo(80.0925, 1e-3));
      expect(red.b, closeTo(67.2032, 1e-3));
    });

    test('agrees with the values the Python extractor produces', () {
      // Straight from workers/vision/color.py for the demo wardrobe's colours.
      const expected = {
        '#1B2A4A': [17.3817, 5.1189, -21.8134],
        '#B08245': [57.6813, 10.9414, 39.4167],
        '#6E1B2E': [24.6304, 37.5613, 9.4558],
        '#9AA0A6': [65.5649, -0.9384, -3.8557],
        '#36393F': [23.8994, 0.2021, -4.1526],
        '#4A6FA5': [46.3653, 3.1612, -33.0170],
        '#6B4A2F': [34.4559, 10.6317, 21.6237],
      };
      expected.forEach((hex, lab) {
        final actual = hexToLab(hex);
        expect(actual.l, closeTo(lab[0], 1e-3), reason: hex);
        expect(actual.a, closeTo(lab[1], 1e-3), reason: hex);
        expect(actual.b, closeTo(lab[2], 1e-3), reason: hex);
      });
    });

    test('short hex and a missing hash both parse', () {
      expect(hexToLab('#FFF').l, closeTo(100, 1e-3));
      expect(hexToLab('1B2A4A').l, closeTo(17.3817, 1e-3));
    });
  });

  group('hue distance', () {
    test('wraps around the colour wheel', () {
      expect(hueDistance(10, 350), closeTo(20, 1e-9));
      expect(hueDistance(350, 10), closeTo(20, 1e-9));
      expect(hueDistance(0, 180), closeTo(180, 1e-9));
      expect(hueDistance(45, 45), closeTo(0, 1e-9));
    });
  });
}
