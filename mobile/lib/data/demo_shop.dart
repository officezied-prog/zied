import '../core/color_math.dart';
import '../models/models.dart';
import 'demo_repositories.dart';
import 'repositories.dart';

/// Something on a rack, as the camera would have read it.
///
/// The demo cannot photograph a shop, so it offers a rail to pick from. What
/// happens *after* the pick is the real thing: the same duplicate detection,
/// the same pairing arithmetic, the same thresholds as the server.
class RackItem {
  const RackItem({
    required this.id,
    required this.name,
    required this.category,
    required this.role,
    required this.hex,
    required this.family,
    this.formality = 3,
    this.pattern = 'solid',
  });

  final String id;
  final String name;
  final String category;
  final String role;
  final String hex;
  final String family;
  final int formality;
  final String pattern;

  int get argb => int.parse('FF${hex.replaceAll('#', '')}', radix: 16);
}

/// A rail worth walking past: one thing the wardrobe already has three of, one
/// it has none of, one that pairs with almost nothing, and a few in between.
const demoRack = <RackItem>[
  RackItem(id: 'r1', name: 'Navy poplin shirt', category: 'shirt',
      role: 'base_top', hex: '#1D2C4C', family: 'navy', formality: 4,),
  RackItem(id: 'r2', name: 'Olive field jacket', category: 'blazer',
      role: 'outerwear', hex: '#6B7238', family: 'olive', formality: 3,),
  RackItem(id: 'r3', name: 'Burgundy leather tote', category: 'tote',
      role: 'bag', hex: '#6E1B2E', family: 'burgundy', formality: 4,),
  RackItem(id: 'r4', name: 'Cream linen trousers', category: 'tailored_trousers',
      role: 'bottom', hex: '#F5EFE0', family: 'cream', formality: 4,),
  RackItem(id: 'r5', name: 'Coral silk blouse', category: 'blouse',
      role: 'base_top', hex: '#FF7F6B', family: 'coral', formality: 3,),
  RackItem(id: 'r6', name: 'White leather trainers', category: 'minimal_sneakers',
      role: 'footwear', hex: '#FAFAFA', family: 'white', formality: 3,),
  RackItem(id: 'r7', name: 'Purple velvet blazer', category: 'blazer',
      role: 'outerwear', hex: '#7C3AED', family: 'purple', formality: 4,),
];

// ── the rules, mirrored from the server ─────────────────────────────────────

/// Two garments closer than this in CIEDE2000, in the same category, are the
/// same purchase.
const double duplicateDeltaE = 8.0;

/// A pair at or above this can be worn together. The colour catalogue scores a
/// neutral anchor at exactly 0.65 — "safe with anything" — so the bar sits
/// here; above it, an olive jacket read as unwearable against a wardrobe of
/// navy, grey and camel, which is nonsense.
const double wearable = 0.65;

/// A pair at or above this is actively good, and worth naming as an outfit.
const double pairsWell = 0.75;

/// Above this share of a role, a colour is spent.
const double saturatedShare = 0.40;

/// Roles that combine with each other into an outfit.
const Map<String, Set<String>> complements = {
  'base_top': {'bottom', 'outerwear', 'footwear', 'bag'},
  'mid_layer': {'bottom', 'outerwear', 'footwear'},
  'bottom': {'base_top', 'mid_layer', 'outerwear', 'footwear', 'bag'},
  'full_body': {'outerwear', 'footwear', 'bag', 'belt'},
  'outerwear': {'base_top', 'bottom', 'full_body', 'footwear'},
  'footwear': {'base_top', 'bottom', 'full_body', 'outerwear', 'bag'},
  'bag': {'base_top', 'bottom', 'full_body', 'footwear'},
};

/// Families the colour catalogue marks as neutral — they anchor anything.
const Set<String> neutralFamilies = {
  'black', 'charcoal', 'grey', 'white', 'cream', 'beige', 'camel', 'brown',
  'navy', 'denim', 'olive', 'forest', 'gold', 'silver',
};

/// The curated pairings, keyed both ways round.
const Map<String, double> curatedPairs = {
  'navy|camel': 0.95, 'navy|white': 0.94, 'navy|burgundy': 0.82,
  'navy|black': 0.45, 'black|white': 0.92, 'black|cream': 0.88,
  'black|gold': 0.90, 'black|red': 0.85, 'charcoal|burgundy': 0.86,
  'grey|blush': 0.88, 'grey|navy': 0.84, 'grey|yellow': 0.80,
  'white|denim': 0.93, 'white|light_blue': 0.85, 'cream|camel': 0.90,
  'cream|olive': 0.84, 'beige|forest': 0.86, 'camel|burgundy': 0.84,
  'camel|forest': 0.83, 'brown|blue': 0.80, 'olive|coral': 0.82,
  'olive|mustard': 0.78, 'denim|coral': 0.84, 'denim|mustard': 0.80,
  'teal|coral': 0.86, 'pink|red': 0.72, 'pink|green': 0.62,
  'purple|yellow': 0.55, 'red|orange': 0.50, 'red|green': 0.25,
  'brown|black': 0.40, 'mint|lavender': 0.74, 'silver|light_blue': 0.82,
  'gold|burgundy': 0.86,
};

/// How well two colours go together, following `public.score_color_pair`:
/// the curated table first, then a neutral anchor, then hue geometry.
double pairScore(String familyA, String familyB, Lab labA, Lab labB) {
  final curated = curatedPairs['$familyA|$familyB'] ??
      curatedPairs['$familyB|$familyA'];
  if (curated != null) return curated;

  if (neutralFamilies.contains(familyA) || neutralFamilies.contains(familyB)) {
    return 0.65;
  }

  final dh = hueDistance(labA.hue, labB.hue);
  double score;
  if (dh <= 12) {
    score = 0.80;
  } else if (dh <= 45) {
    score = 0.75;
  } else if (dh <= 95) {
    score = 0.35;                       // the awkward middle
  } else if (dh <= 135) {
    score = 0.60;
  } else if (dh <= 165) {
    score = 0.70;
  } else {
    score = 0.78;
  }

  // Two high-chroma hero colours fight each other.
  if (labA.chroma > 55 && labB.chroma > 55 && dh > 45) score -= 0.25;
  return score;
}

/// Roles named the way a person names them, always plural.
const Map<String, String> rolePhrase = {
  'base_top': 'tops',
  'mid_layer': 'mid layers',
  'bottom': 'bottoms',
  'full_body': 'one-pieces',
  'outerwear': 'outer layers',
  'footwear': 'shoes',
  'bag': 'bags',
  'belt': 'belts',
};

/// Which body region each role covers on its own — `public.role_covers`.
const Map<String, List<String>> roleCovers = {
  'base_top': ['torso'],
  'mid_layer': ['torso'],
  'outerwear': ['torso'],
  'full_body': ['torso', 'legs'],
  'bottom': ['legs'],
  'hosiery': ['legs'],
  'footwear': ['feet'],
};

String _join(List<String> parts, {String conjunction = 'or'}) {
  if (parts.length <= 1) return parts.join();
  return '${parts.sublist(0, parts.length - 1).join(', ')} '
      '$conjunction ${parts.last}';
}

/// Shop mode with no server: the same arithmetic, run against `DemoData`.
class DemoShopRepository implements ShopRepository {
  final Map<String, ScanResult> _scans = {};
  var _counter = 0;

  RackItem rackItem(String id) => demoRack.firstWhere((r) => r.id == id);

  @override
  Future<ScanResult> scan(String mediaId, {String? role}) async {
    await Future<void>.delayed(const Duration(milliseconds: 850));
    final item = rackItem(mediaId);
    final result = judge(item, DemoData.wardrobe, role: role,
        scanId: 'scan-${_counter++}',);
    _scans[result.scanId] = result;
    return result;
  }

  @override
  Future<List<ScanResult>> openScans({int limit = 20}) async =>
      _scans.values.toList().reversed.take(limit).toList();

  @override
  Future<String> markBought(String scanId) async {
    await Future<void>.delayed(const Duration(milliseconds: 250));
    final scan = _scans.remove(scanId);
    if (scan == null) return '';
    final garment = Garment(
      id: 'bought-$scanId',
      category: scan.category,
      categoryId: 0,
      role: scan.role,
      name: '${scan.colorFamily[0].toUpperCase()}${scan.colorFamily.substring(1)}'
          ' ${scan.displayCategory}',
      pattern: scan.pattern,
      formality: 3,
      warmth: 1,
      seasons: const ['all_season'],
      colors: [
        GarmentColor(hex: scan.primaryHex, ratio: 1, family: scan.colorFamily,
            isNeutral: neutralFamilies.contains(scan.colorFamily),),
      ],
      wearCount: 0,
      inLaundry: false,
      autoTagged: false,
      userVerified: true,
    );
    DemoData.wardrobe.add(garment);
    return garment.id;
  }

  @override
  Future<void> dismiss(String scanId) async {
    await Future<void>.delayed(const Duration(milliseconds: 150));
    _scans.remove(scanId);
  }
}

/// The verdict, computed the way `workers/styling/shopping.py` computes it.
///
/// Split out from the repository so it can be tested directly, and so the
/// numbers on screen are demonstrably arithmetic rather than a fixed script.
ScanResult judge(RackItem item, List<Garment> wardrobe,
    {String? role, String scanId = 'scan',}) {
  final effectiveRole = role ?? item.role;
  final lab = hexToLab(item.hex);

  final duplicates = <OwnedMatch>[];
  for (final owned in wardrobe) {
    final colour = owned.primaryColor;
    if (colour == null || owned.category != item.category) continue;
    final delta = ciede2000(lab, hexToLab(colour.hex));
    if (delta <= duplicateDeltaE) {
      duplicates.add(OwnedMatch(
        garmentId: owned.id,
        name: owned.displayName,
        hex: colour.hex,
        deltaE: double.parse(delta.toStringAsFixed(2)),
      ),);
    }
  }
  duplicates.sort((a, b) => a.deltaE.compareTo(b.deltaE));

  final pairable = complements[effectiveRole] ?? const <String>{};
  var totalComplements = 0;
  var newPairings = 0;
  final matches = <WearWith>[];
  for (final owned in wardrobe) {
    final colour = owned.primaryColor;
    if (colour == null || !pairable.contains(owned.role)) continue;
    totalComplements++;
    final score = pairScore(item.family, colour.family, lab, hexToLab(colour.hex));
    if (score < wearable) continue;
    newPairings++;
    if (score >= pairsWell) {
      matches.add(WearWith(
        garmentId: owned.id,
        name: owned.displayName,
        role: owned.role,
        hex: colour.hex,
        score: double.parse(score.toStringAsFixed(3)),
      ),);
    }
  }
  final wearWith = _onePerRole(matches);

  final inRole = wardrobe.where((g) => g.role == effectiveRole).length;
  final inRoleAndFamily = wardrobe
      .where((g) => g.role == effectiveRole && g.primaryColor?.family == item.family)
      .length;
  final roleFamilyShare = inRole == 0 ? 0.0 : inRoleAndFamily / inRole;

  final unlocked = _unlockedOccasions(item, wardrobe, effectiveRole);
  final pairingShare =
      totalComplements == 0 ? 0.0 : newPairings / totalComplements;

  final verdict = _decide(
    duplicates: duplicates.length,
    unlocked: unlocked,
    pairingShare: pairingShare,
    roleFamilyShare: roleFamilyShare,
  );

  final lookForColors = verdict == ScanVerdict.haveSimilar ||
          verdict == ScanVerdict.hardToWear
      ? _colorOpportunities(wardrobe)
      : const <ColorOpportunity>[];
  final lookForRoles = verdict == ScanVerdict.haveSimilar ||
          verdict == ScanVerdict.hardToWear
      ? _thinRoles(wardrobe)
      : const <String>[];

  final described = _describe(
    item: item,
    role: effectiveRole,
    verdict: verdict,
    duplicates: duplicates,
    newPairings: newPairings,
    totalComplements: totalComplements,
    roleFamilyShare: roleFamilyShare,
    unlocked: unlocked,
    wearWith: wearWith,
    lookForColors: lookForColors,
    lookForRoles: lookForRoles,
  );

  return ScanResult(
    scanId: scanId,
    category: item.category,
    role: effectiveRole,
    primaryHex: item.hex,
    colorFamily: item.family,
    pattern: item.pattern,
    confidence: 0.82,
    verdict: verdict,
    headline: described.$1,
    detail: described.$2,
    newPairings: newPairings,
    totalComplements: totalComplements,
    pairingShare: double.parse(pairingShare.toStringAsFixed(3)),
    duplicates: duplicates,
    unlockedOccasions: unlocked,
    wearWith: wearWith,
    lookForColors: lookForColors,
    lookForRoles: lookForRoles,
  );
}

ScanVerdict _decide({
  required int duplicates,
  required List<String> unlocked,
  required double pairingShare,
  required double roleFamilyShare,
}) {
  if (unlocked.isNotEmpty) return ScanVerdict.fillsAGap;
  if (duplicates > 0 || roleFamilyShare >= saturatedShare) {
    return ScanVerdict.haveSimilar;
  }
  if (pairingShare < 0.25) return ScanVerdict.hardToWear;
  return ScanVerdict.addsVariety;
}

/// An outfit, not a list: the best of each role, in the order worn.
List<WearWith> _onePerRole(List<WearWith> matches, {int limit = 3}) {
  const order = ['base_top', 'full_body', 'bottom', 'mid_layer', 'outerwear',
    'footwear', 'bag', 'belt',];
  final best = <String, WearWith>{};
  final sorted = [...matches]..sort((a, b) {
    final byScore = b.score.compareTo(a.score);
    return byScore != 0 ? byScore : a.name.compareTo(b.name);
  });
  for (final match in sorted) {
    best.putIfAbsent(match.role, () => match);
  }
  final ranked = best.values.toList()
    ..sort((a, b) {
      final ai = order.contains(a.role) ? order.indexOf(a.role) : 99;
      final bi = order.contains(b.role) ? order.indexOf(b.role) : 99;
      return ai.compareTo(bi);
    });
  return ranked.take(limit).toList();
}

/// Occasions blocked today that this garment would make wearable.
List<String> _unlockedOccasions(RackItem item, List<Garment> wardrobe,
    String role,) {
  final fills = {...roleCovers[role] ?? const <String>[]};
  if (fills.isEmpty) return const [];

  final unlocked = <String>[];
  for (final occasion in DemoData.occasions) {
    final wearable = wardrobe.where((g) =>
        g.formality >= occasion.formalityMin &&
        g.formality <= occasion.formalityMax,);
    final covered = <String>{};
    for (final g in wearable) {
      covered.addAll(roleCovers[g.role] ?? const []);
    }
    // Every occasion in the catalogue asks for footwear on top of the body.
    final missing = {'torso', 'legs', 'feet'}.difference(covered);
    if (missing.isEmpty) continue;
    if (item.formality < occasion.formalityMin ||
        item.formality > occasion.formalityMax) {
      continue;
    }
    if (missing.difference(fills).isEmpty) unlocked.add(occasion.displayName);
  }
  return unlocked;
}

/// Colours the wardrobe barely has, ranked by what they would pair with.
List<ColorOpportunity> _colorOpportunities(List<Garment> wardrobe, {int limit = 3}) {
  final owned = <String, int>{};
  for (final g in wardrobe) {
    final family = g.primaryColor?.family;
    if (family != null) owned[family] = (owned[family] ?? 0) + 1;
  }

  final candidates = <ColorOpportunity>[];
  for (final family in curatedFamilies) {
    if ((owned[family.slug] ?? 0) > 0) continue;
    final lab = hexToLab(family.anchorHex);
    var pairs = 0;
    for (final g in wardrobe) {
      final colour = g.primaryColor;
      if (colour == null) continue;
      if (pairScore(family.slug, colour.family, lab, hexToLab(colour.hex)) >=
          pairsWell) {
        pairs++;
      }
    }
    candidates.add(ColorOpportunity(
      family: family.slug,
      pairsWith: pairs,
      coverage: wardrobe.isEmpty ? 0 : pairs / wardrobe.length,
      isNeutral: neutralFamilies.contains(family.slug),
    ),);
  }
  candidates.sort((a, b) => b.pairsWith.compareTo(a.pairsWith));
  return candidates.take(limit).toList();
}

/// Shapes the wardrobe is short of, thinnest first.
List<String> _thinRoles(List<Garment> wardrobe, {int limit = 3}) {
  const considered = ['base_top', 'bottom', 'full_body', 'outerwear',
    'footwear', 'bag',];
  final counts = {
    for (final role in considered)
      role: wardrobe.where((g) => g.role == role).length,
  };
  final thin = considered.where((r) => counts[r]! <= 1).toList()
    ..sort((a, b) {
      final byCount = counts[a]!.compareTo(counts[b]!);
      return byCount != 0 ? byCount : a.compareTo(b);
    });
  return thin.take(limit).toList();
}

/// The colour catalogue, trimmed to the families a demo wardrobe might want.
class DemoColorFamily {
  const DemoColorFamily(this.slug, this.anchorHex);

  final String slug;
  final String anchorHex;
}

const curatedFamilies = <DemoColorFamily>[
  DemoColorFamily('black', '#111111'),
  DemoColorFamily('charcoal', '#36393F'),
  DemoColorFamily('grey', '#9AA0A6'),
  DemoColorFamily('white', '#FFFFFF'),
  DemoColorFamily('cream', '#F5EFE0'),
  DemoColorFamily('beige', '#D9C7A7'),
  DemoColorFamily('camel', '#B08245'),
  DemoColorFamily('brown', '#6B4A2F'),
  DemoColorFamily('navy', '#1B2A4A'),
  DemoColorFamily('denim', '#4A6FA5'),
  DemoColorFamily('olive', '#6B7238'),
  DemoColorFamily('forest', '#1F3D2B'),
  DemoColorFamily('burgundy', '#6E1B2E'),
  DemoColorFamily('teal', '#0F766E'),
  DemoColorFamily('coral', '#FF7F6B'),
  DemoColorFamily('blush', '#F3C9C6'),
  DemoColorFamily('mustard', '#C99A2E'),
];

(String, String) _describe({
  required RackItem item,
  required String role,
  required ScanVerdict verdict,
  required List<OwnedMatch> duplicates,
  required int newPairings,
  required int totalComplements,
  required double roleFamilyShare,
  required List<String> unlocked,
  required List<WearWith> wearWith,
  required List<ColorOpportunity> lookForColors,
  required List<String> lookForRoles,
}) {
  final colour = item.family.replaceAll('_', ' ');
  final outfit = wearWith.isEmpty
      ? ''
      : ' Wear it with your '
          '${_join(wearWith.map((w) => w.name).toList(), conjunction: 'and')}.';

  switch (verdict) {
    case ScanVerdict.fillsAGap:
      final names = unlocked.map((o) => o.toLowerCase()).toList();
      final blocked = names.length <= 2
          ? 'You cannot dress ${_join(names)} today.'
          : 'You cannot dress ${names.length} occasions today, '
              '${_join(names.sublist(0, 2), conjunction: 'and')} among them.';
      return ('This fills a real gap.',
          '$blocked This would fix that, and it works with $newPairings '
              'pieces you already own.$outfit');

    case ScanVerdict.haveSimilar:
      final have = duplicates.isNotEmpty
          ? 'You already own ${duplicates.length} almost exactly like it '
              '(${_join(duplicates.take(2).map((d) => d.name).toList(), conjunction: 'and')}).'
          : 'Of the ${rolePhrase[role] ?? role} you own, '
              '${(roleFamilyShare * 100).round()}% are already $colour.';
      return ('You have this covered.',
          '$have ${_missing(lookForColors, lookForRoles)}'.trim());

    case ScanVerdict.hardToWear:
      return ('This would be hard to wear.',
          'It works with only $newPairings of $totalComplements pieces you '
              'own. ${_missing(lookForColors, lookForRoles)}'.trim());

    case ScanVerdict.addsVariety:
      return ('This would earn its place.',
          'It works with $newPairings of $totalComplements pieces you already '
              'own.$outfit');
  }
}

String _missing(List<ColorOpportunity> colors, List<String> roles) {
  final parts = <String>[];
  if (colors.isNotEmpty) {
    parts.add('What you are short of is '
        '${_join(colors.take(3).map((c) => c.family.replaceAll('_', ' ')).toList())}');
  }
  if (roles.isNotEmpty) {
    parts.add('and you own almost no '
        '${_join(roles.map((r) => rolePhrase[r] ?? r.replaceAll('_', ' ')).toList())}');
  }
  return parts.isEmpty ? '' : '${parts.join(' ')}.';
}
