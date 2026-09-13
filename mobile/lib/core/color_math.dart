import 'dart:math' as math;

/// CIELAB and CIEDE2000, ported from `workers/vision/color.py`.
///
/// Demo mode judges a garment against the wardrobe on the device, with no
/// server to ask, and "is this the same colour as one I own" is a perceptual
/// question that RGB distance answers wrongly. This is the same maths the
/// backend and the database use, pinned to the same Sharma et al. reference
/// pairs in `test/color_math_test.dart`, so the demo's verdicts are the ones
/// the real engine would give.
class Lab {
  const Lab(this.l, this.a, this.b);

  final double l;
  final double a;
  final double b;

  /// Chroma — how far the colour is from grey.
  double get chroma => math.sqrt(a * a + b * b);

  /// Hue angle in degrees, 0–360.
  double get hue => (math.atan2(b, a) * 180 / math.pi + 360) % 360;

  bool get isNeutral => chroma < 12;
}

const _whiteX = 0.95047;
const _whiteY = 1.00000;
const _whiteZ = 1.08883;

double _linear(double channel) => channel > 0.04045
    ? math.pow((channel + 0.055) / 1.055, 2.4).toDouble()
    : channel / 12.92;

double _f(double t) {
  const eps = 216 / 24389;
  const kappa = 24389 / 27;
  return t > eps ? math.pow(t, 1 / 3).toDouble() : (kappa * t + 16) / 116;
}

/// `#RRGGBB` (with or without the hash) to CIELAB, D65 / 2°.
Lab hexToLab(String hex) {
  final clean = hex.replaceAll('#', '').trim();
  final value = int.parse(clean.length == 3
      ? clean.split('').map((c) => '$c$c').join()
      : clean, radix: 16,);
  return rgbToLab(
    (value >> 16) & 0xFF,
    (value >> 8) & 0xFF,
    value & 0xFF,
  );
}

Lab rgbToLab(int r, int g, int b) {
  final rl = _linear(r / 255);
  final gl = _linear(g / 255);
  final bl = _linear(b / 255);

  final x = (0.4124564 * rl + 0.3575761 * gl + 0.1804375 * bl) / _whiteX;
  final y = (0.2126729 * rl + 0.7151522 * gl + 0.0721750 * bl) / _whiteY;
  final z = (0.0193339 * rl + 0.1191920 * gl + 0.9503041 * bl) / _whiteZ;

  final fx = _f(x);
  final fy = _f(y);
  final fz = _f(z);
  return Lab(116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz));
}

double _radians(double degrees) => degrees * math.pi / 180;

/// CIEDE2000 colour difference. Under ~2 is imperceptible; around 8 is where a
/// person stops calling two garments the same colour.
double ciede2000(Lab one, Lab two) {
  final c1 = one.chroma;
  final c2 = two.chroma;
  final cBar = (c1 + c2) / 2;
  final cBar7 = math.pow(cBar, 7).toDouble();
  final g = 0.5 * (1 - math.sqrt(cBar7 / (cBar7 + math.pow(25, 7))));

  final a1p = (1 + g) * one.a;
  final a2p = (1 + g) * two.a;
  final c1p = math.sqrt(a1p * a1p + one.b * one.b);
  final c2p = math.sqrt(a2p * a2p + two.b * two.b);

  final h1p = (a1p == 0 && one.b == 0)
      ? 0.0
      : (math.atan2(one.b, a1p) * 180 / math.pi + 360) % 360;
  final h2p = (a2p == 0 && two.b == 0)
      ? 0.0
      : (math.atan2(two.b, a2p) * 180 / math.pi + 360) % 360;

  final dLp = two.l - one.l;
  final dCp = c2p - c1p;
  final dh = h2p - h1p;
  final double dhp;
  if (c1p * c2p == 0) {
    dhp = 0;
  } else if (dh.abs() <= 180) {
    dhp = dh;
  } else {
    dhp = dh > 180 ? dh - 360 : dh + 360;
  }
  final dHp = 2 * math.sqrt(c1p * c2p) * math.sin(_radians(dhp / 2));

  final lBar = (one.l + two.l) / 2;
  final cBarP = (c1p + c2p) / 2;
  final hSum = h1p + h2p;
  final double hBarP;
  if (c1p * c2p == 0) {
    hBarP = hSum;
  } else if ((h1p - h2p).abs() <= 180) {
    hBarP = hSum / 2;
  } else {
    hBarP = hSum < 360 ? (hSum + 360) / 2 : (hSum - 360) / 2;
  }

  final t = 1 -
      0.17 * math.cos(_radians(hBarP - 30)) +
      0.24 * math.cos(_radians(2 * hBarP)) +
      0.32 * math.cos(_radians(3 * hBarP + 6)) -
      0.20 * math.cos(_radians(4 * hBarP - 63));
  final dTheta = 30 * math.exp(-math.pow((hBarP - 275) / 25, 2).toDouble());
  final cBarP7 = math.pow(cBarP, 7).toDouble();
  final rc = 2 * math.sqrt(cBarP7 / (cBarP7 + math.pow(25, 7)));
  final sl = 1 +
      (0.015 * math.pow(lBar - 50, 2)) / math.sqrt(20 + math.pow(lBar - 50, 2));
  final sc = 1 + 0.045 * cBarP;
  final sh = 1 + 0.015 * cBarP * t;
  final rt = -math.sin(_radians(2 * dTheta)) * rc;

  return math.sqrt(math.pow(dLp / sl, 2) +
      math.pow(dCp / sc, 2) +
      math.pow(dHp / sh, 2) +
      rt * (dCp / sc) * (dHp / sh),);
}

/// Shortest distance between two hue angles, in degrees (0–180).
double hueDistance(double a, double b) {
  final delta = (a - b).abs() % 360;
  return delta > 180 ? 360 - delta : delta;
}
