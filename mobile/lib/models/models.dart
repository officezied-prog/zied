import 'package:flutter/foundation.dart';

T? _as<T>(dynamic value) => value is T ? value : null;

double? _toDouble(dynamic v) => v == null ? null : (v as num).toDouble();

List<String> _strings(dynamic v) =>
    (v as List?)?.map((e) => e.toString()).toList() ?? const [];

DateTime? _date(dynamic v) => v == null ? null : DateTime.tryParse(v.toString());

/// A colour extracted from the garment, in the vocabulary the styling engine
/// reasons in (family) plus the exact swatch to draw (hex).
@immutable
class GarmentColor {
  const GarmentColor({
    required this.hex,
    required this.ratio,
    required this.family,
    required this.isNeutral,
  });

  final String hex;
  final double ratio;
  final String family;
  final bool isNeutral;

  factory GarmentColor.fromJson(Map<String, dynamic> json) => GarmentColor(
        hex: json['hex'] as String,
        ratio: _toDouble(json['ratio']) ?? 0,
        family: (json['color_family'] ?? '').toString(),
        isNeutral: json['is_neutral'] == true,
      );

  int get argb => int.parse('FF${hex.replaceAll('#', '')}', radix: 16);
}

@immutable
class Garment {
  const Garment({
    required this.id,
    required this.category,
    required this.categoryId,
    required this.role,
    required this.formality,
    required this.warmth,
    required this.colors,
    required this.wearCount,
    required this.inLaundry,
    required this.autoTagged,
    required this.userVerified,
    this.name,
    this.brand,
    this.pattern = 'solid',
    this.material = const [],
    this.seasons = const [],
    this.imageUrl,
    this.cutoutUrl,
    this.lastWornAt,
    this.tagConfidence,
  });

  final String id;
  final String category;
  final int categoryId;
  final String role;
  final int formality;
  final int warmth;
  final List<GarmentColor> colors;
  final int wearCount;
  final bool inLaundry;
  final bool autoTagged;
  final bool userVerified;
  final String? name;
  final String? brand;
  final String pattern;
  final List<String> material;
  final List<String> seasons;
  final String? imageUrl;
  final String? cutoutUrl;
  final DateTime? lastWornAt;
  final double? tagConfidence;

  factory Garment.fromJson(Map<String, dynamic> json) => Garment(
        id: json['id'] as String,
        category: (json['category'] ?? '').toString(),
        categoryId: (json['category_id'] as num?)?.toInt() ?? 0,
        role: (json['role'] ?? 'other_accessory').toString(),
        formality: (json['formality'] as num?)?.toInt() ?? 3,
        warmth: (json['warmth'] as num?)?.toInt() ?? 2,
        colors: ((json['colors'] as List?) ?? const [])
            .map((e) => GarmentColor.fromJson(e as Map<String, dynamic>))
            .toList(),
        wearCount: (json['wear_count'] as num?)?.toInt() ?? 0,
        inLaundry: json['in_laundry'] == true,
        autoTagged: json['auto_tagged'] == true,
        userVerified: json['user_verified'] == true,
        name: _as<String>(json['name']),
        brand: _as<String>(json['brand']),
        pattern: (json['pattern'] ?? 'solid').toString(),
        material: _strings(json['material']),
        seasons: _strings(json['seasons']),
        imageUrl: _as<String>(json['image_url']),
        cutoutUrl: _as<String>(json['cutout_url']),
        lastWornAt: _date(json['last_worn_at']),
        tagConfidence: _toDouble(json['tag_confidence']),
      );

  String get displayName => name?.trim().isNotEmpty == true
      ? name!
      : category.replaceAll('_', ' ');

  GarmentColor? get primaryColor => colors.isEmpty ? null : colors.first;

  /// Auto-tagged and never confirmed by the user: worth a nudge in the UI.
  bool get needsConfirmation => autoTagged && !userVerified;
}

@immutable
class OutfitItem {
  const OutfitItem({required this.role, required this.layerOrder, required this.garment});

  final String role;
  final int layerOrder;
  final Garment garment;

  factory OutfitItem.fromJson(Map<String, dynamic> json) => OutfitItem(
        role: (json['role'] ?? '').toString(),
        layerOrder: (json['layer_order'] as num?)?.toInt() ?? 0,
        garment: Garment.fromJson(json['garment'] as Map<String, dynamic>),
      );
}

@immutable
class Outfit {
  const Outfit({
    required this.id,
    required this.origin,
    required this.items,
    required this.createdAt,
    this.name,
    this.occasion,
    this.totalScore,
    this.scoreBreakdown = const {},
    this.rationale,
    this.formality,
    this.dominantColors = const [],
    this.isFavorite = false,
  });

  final String id;
  final String origin;
  final List<OutfitItem> items;
  final DateTime createdAt;
  final String? name;
  final String? occasion;
  final double? totalScore;
  final Map<String, double> scoreBreakdown;
  final String? rationale;
  final int? formality;
  final List<String> dominantColors;
  final bool isFavorite;

  factory Outfit.fromJson(Map<String, dynamic> json) => Outfit(
        id: json['id'] as String,
        origin: (json['origin'] ?? 'ai').toString(),
        items: ((json['items'] as List?) ?? const [])
            .map((e) => OutfitItem.fromJson(e as Map<String, dynamic>))
            .toList(),
        createdAt: _date(json['created_at']) ?? DateTime.now(),
        name: _as<String>(json['name']),
        occasion: _as<String>(json['occasion']),
        totalScore: _toDouble(json['total_score']),
        scoreBreakdown: {
          for (final e in ((json['score_breakdown'] as Map?) ?? const {}).entries)
            e.key.toString(): (e.value as num).toDouble(),
        },
        rationale: _as<String>(json['rationale']),
        formality: (json['formality'] as num?)?.toInt(),
        dominantColors: _strings(json['dominant_colors']),
        isFavorite: json['is_favorite'] == true,
      );

  /// Body-first ordering so the card reads top to bottom like a person.
  List<OutfitItem> get orderedItems {
    const rank = {
      'headwear': 0, 'eyewear': 1, 'base_top': 2, 'full_body': 2, 'mid_layer': 3,
      'outerwear': 4, 'bottom': 5, 'belt': 6, 'footwear': 7, 'bag': 8,
    };
    final sorted = [...items];
    sorted.sort((a, b) => (rank[a.role] ?? 9).compareTo(rank[b.role] ?? 9));
    return sorted;
  }

  /// The two strongest reasons this look was suggested — what the card shows.
  List<MapEntry<String, double>> get topReasons {
    final entries = scoreBreakdown.entries
        .where((e) => e.key != 'completeness')
        .toList()
      ..sort((a, b) => b.value.compareTo(a.value));
    return entries.take(2).toList();
  }
}

@immutable
class Occasion {
  const Occasion({
    required this.id,
    required this.slug,
    required this.displayName,
    required this.formalityMin,
    required this.formalityMax,
    this.description,
    this.icon,
    this.isCustom = false,
  });

  final int id;
  final String slug;
  final String displayName;
  final int formalityMin;
  final int formalityMax;
  final String? description;
  final String? icon;
  final bool isCustom;

  factory Occasion.fromJson(Map<String, dynamic> json) => Occasion(
        id: (json['id'] as num).toInt(),
        slug: json['slug'] as String,
        displayName: json['display_name'] as String,
        formalityMin: (json['formality_min'] as num).toInt(),
        formalityMax: (json['formality_max'] as num).toInt(),
        description: _as<String>(json['description']),
        icon: _as<String>(json['icon']),
        isCustom: json['is_custom'] == true,
      );
}

@immutable
class Weather {
  const Weather({
    required this.tempC,
    this.feelsLikeC,
    this.precipProb = 0,
    this.condition,
    this.uvIndex,
  });

  final double tempC;
  final double? feelsLikeC;
  final double precipProb;
  final String? condition;
  final double? uvIndex;

  factory Weather.fromJson(Map<String, dynamic> json) => Weather(
        tempC: _toDouble(json['temp_c']) ?? 0,
        feelsLikeC: _toDouble(json['feels_like_c']),
        precipProb: _toDouble(json['precip_prob']) ?? 0,
        condition: _as<String>(json['condition']),
        uvIndex: _toDouble(json['uv_index']),
      );

  Map<String, dynamic> toJson() => {
        'temp_c': tempC,
        if (feelsLikeC != null) 'feels_like_c': feelsLikeC,
        'precip_prob': precipProb,
        if (condition != null) 'condition': condition,
      };

  double get effectiveTemp => feelsLikeC ?? tempC;
  bool get isWet => precipProb >= 0.4;
}

@immutable
class Recommendation {
  const Recommendation({
    required this.runId,
    required this.engineVersion,
    required this.outfits,
    required this.candidateCount,
    required this.latencyMs,
    this.weather,
  });

  final String runId;
  final String engineVersion;
  final List<Outfit> outfits;
  final int candidateCount;
  final int latencyMs;
  final Weather? weather;

  factory Recommendation.fromJson(Map<String, dynamic> json) => Recommendation(
        runId: json['run_id'] as String,
        engineVersion: (json['engine_version'] ?? '').toString(),
        outfits: ((json['outfits'] as List?) ?? const [])
            .map((e) => Outfit.fromJson(e as Map<String, dynamic>))
            .toList(),
        candidateCount: (json['candidate_count'] as num?)?.toInt() ?? 0,
        latencyMs: (json['latency_ms'] as num?)?.toInt() ?? 0,
        weather: json['weather'] == null
            ? null
            : Weather.fromJson(json['weather'] as Map<String, dynamic>),
      );
}

@immutable
class TryOnJob {
  const TryOnJob({
    required this.id,
    required this.status,
    required this.modelId,
    required this.queuedAt,
    this.resultUrl,
    this.passIndex = 0,
    this.totalPasses = 1,
    this.queuePosition,
    this.pollAfterMs = 3000,
    this.qaFlags = const [],
    this.errorCode,
    this.cacheHit = false,
  });

  final String id;
  final String status;
  final String modelId;
  final DateTime queuedAt;
  final String? resultUrl;
  final int passIndex;
  final int totalPasses;
  final int? queuePosition;
  final int pollAfterMs;
  final List<String> qaFlags;
  final String? errorCode;
  final bool cacheHit;

  factory TryOnJob.fromJson(Map<String, dynamic> json) => TryOnJob(
        id: json['id'] as String,
        status: (json['status'] ?? 'queued').toString(),
        modelId: (json['model_id'] ?? '').toString(),
        queuedAt: _date(json['queued_at']) ?? DateTime.now(),
        resultUrl: _as<String>(json['result_url']),
        passIndex: (json['pass_index'] as num?)?.toInt() ?? 0,
        totalPasses: (json['total_passes'] as num?)?.toInt() ?? 1,
        queuePosition: (json['queue_position'] as num?)?.toInt(),
        pollAfterMs: (json['poll_after_ms'] as num?)?.toInt() ?? 3000,
        qaFlags: _strings(json['qa_flags']),
        errorCode: _as<String>(json['error_code']),
        cacheHit: json['cache_hit'] == true,
      );

  bool get isRunning => status == 'queued' || status == 'running';
  bool get isReady => resultUrl != null && (status == 'succeeded' || status == 'partial');
  double get progress => totalPasses == 0 ? 0 : passIndex / totalPasses;
}

@immutable
class BodyPhoto {
  const BodyPhoto({
    required this.id,
    required this.pose,
    required this.isPrimary,
    required this.status,
    this.url,
    this.qualityScore,
    this.qualityIssues = const [],
  });

  final String id;
  final String pose;
  final bool isPrimary;
  final String status;
  final String? url;
  final double? qualityScore;
  final List<String> qualityIssues;

  factory BodyPhoto.fromJson(Map<String, dynamic> json) => BodyPhoto(
        id: json['id'] as String,
        pose: (json['pose'] ?? 'front_full').toString(),
        isPrimary: json['is_primary'] == true,
        status: (json['status'] ?? 'queued').toString(),
        url: _as<String>(json['url']),
        qualityScore: _toDouble(json['quality_score']),
        qualityIssues: _strings(json['quality_issues']),
      );
}

@immutable
class WardrobeStats {
  const WardrobeStats({
    required this.items,
    required this.neverWorn,
    required this.wornLast30d,
    required this.byRole,
    required this.gaps,
    this.avgCostPerWear,
  });

  final int items;
  final int neverWorn;
  final int wornLast30d;
  final Map<String, int> byRole;
  final List<String> gaps;
  final double? avgCostPerWear;

  factory WardrobeStats.fromJson(Map<String, dynamic> json) => WardrobeStats(
        items: (json['items'] as num?)?.toInt() ?? 0,
        neverWorn: (json['never_worn'] as num?)?.toInt() ?? 0,
        wornLast30d: (json['worn_last_30d'] as num?)?.toInt() ?? 0,
        byRole: {
          for (final e in ((json['by_role'] as Map?) ?? const {}).entries)
            e.key.toString(): (e.value as num).toInt(),
        },
        gaps: _strings(json['gaps']),
        avgCostPerWear: _toDouble(json['avg_cost_per_wear']),
      );
}

@immutable
class DetectionCard {
  const DetectionCard({
    required this.id,
    required this.label,
    required this.confidence,
    this.cutoutUrl,
    this.suggestedCategory,
    this.suggestedCategoryId,
    this.gateFailures = const [],
  });

  final String id;
  final String label;
  final double confidence;
  final String? cutoutUrl;
  final String? suggestedCategory;
  final int? suggestedCategoryId;
  final List<String> gateFailures;

  factory DetectionCard.fromJson(Map<String, dynamic> json) => DetectionCard(
        id: json['id'] as String,
        label: (json['label'] ?? '').toString(),
        confidence: _toDouble(json['confidence']) ?? 0,
        cutoutUrl: _as<String>(json['cutout_url']),
        suggestedCategory: _as<String>(json['suggested_category']),
        suggestedCategoryId: (json['suggested_category_id'] as num?)?.toInt(),
        gateFailures: _strings(json['gate_failures']),
      );

  /// Why the pipeline was unsure — shown so the card explains itself.
  String get reason {
    if (gateFailures.contains('unmapped_label')) return 'Unrecognised item';
    if (gateFailures.contains('low_confidence')) return 'Not sure about this one';
    if (gateFailures.contains('too_small')) return 'Small in the photo';
    if (gateFailures.contains('occluded')) return 'Partly hidden';
    return 'Needs a quick check';
  }
}

@immutable
class IngestJob {
  const IngestJob({
    required this.id,
    required this.status,
    required this.itemsDiscovered,
    required this.itemsProcessed,
    required this.garmentsCreated,
    required this.needsReview,
    this.pollAfterMs = 1500,
  });

  final String id;
  final String status;
  final int itemsDiscovered;
  final int itemsProcessed;
  final int garmentsCreated;
  final int needsReview;
  final int pollAfterMs;

  factory IngestJob.fromJson(Map<String, dynamic> json) => IngestJob(
        id: json['id'] as String,
        status: (json['status'] ?? 'queued').toString(),
        itemsDiscovered: (json['items_discovered'] as num?)?.toInt() ?? 0,
        itemsProcessed: (json['items_processed'] as num?)?.toInt() ?? 0,
        garmentsCreated: (json['garments_created'] as num?)?.toInt() ?? 0,
        needsReview: (json['needs_review'] as num?)?.toInt() ?? 0,
        pollAfterMs: (json['poll_after_ms'] as num?)?.toInt() ?? 1500,
      );

  bool get isRunning => status == 'queued' || status == 'running';
  double get progress =>
      itemsDiscovered == 0 ? 0 : itemsProcessed / itemsDiscovered;
}

// ── shop mode ───────────────────────────────────────────────────────────────

/// What the app thinks of something on a rack, given what is already at home.
enum ScanVerdict {
  fillsAGap('fills_a_gap'),
  addsVariety('adds_variety'),
  haveSimilar('have_similar'),
  hardToWear('hard_to_wear');

  const ScanVerdict(this.wire);

  final String wire;

  static ScanVerdict parse(String? value) => ScanVerdict.values.firstWhere(
        (v) => v.wire == value,
        orElse: () => ScanVerdict.addsVariety,
      );

  bool get isWorthBuying =>
      this == ScanVerdict.fillsAGap || this == ScanVerdict.addsVariety;
}

/// Something already owned that is close enough to be the same purchase.
@immutable
class OwnedMatch {
  const OwnedMatch({
    required this.garmentId,
    required this.name,
    required this.hex,
    required this.deltaE,
  });

  final String garmentId;
  final String name;
  final String hex;
  final double deltaE;

  factory OwnedMatch.fromJson(Map<String, dynamic> json) => OwnedMatch(
        garmentId: json['garment_id'].toString(),
        name: (json['name'] ?? '').toString(),
        hex: (json['hex'] ?? '#000000').toString(),
        deltaE: _toDouble(json['delta_e']) ?? 0,
      );

  int get argb => int.parse('FF${hex.replaceAll('#', '')}', radix: 16);
}

/// A piece at home the scanned garment would go with.
@immutable
class WearWith {
  const WearWith({
    required this.garmentId,
    required this.name,
    required this.role,
    required this.hex,
    required this.score,
  });

  final String garmentId;
  final String name;
  final String role;
  final String hex;
  final double score;

  factory WearWith.fromJson(Map<String, dynamic> json) => WearWith(
        garmentId: json['garment_id'].toString(),
        name: (json['name'] ?? '').toString(),
        role: (json['role'] ?? 'base_top').toString(),
        hex: (json['hex'] ?? '#000000').toString(),
        score: _toDouble(json['score']) ?? 0,
      );

  int get argb => int.parse('FF${hex.replaceAll('#', '')}', radix: 16);
}

/// A colour the wardrobe barely has, ranked by what buying it would unlock.
@immutable
class ColorOpportunity {
  const ColorOpportunity({
    required this.family,
    required this.pairsWith,
    required this.coverage,
    required this.isNeutral,
  });

  final String family;
  final int pairsWith;
  final double coverage;
  final bool isNeutral;

  factory ColorOpportunity.fromJson(Map<String, dynamic> json) => ColorOpportunity(
        family: (json['family'] ?? '').toString(),
        pairsWith: (json['pairs_with'] as num?)?.toInt() ?? 0,
        coverage: _toDouble(json['coverage']) ?? 0,
        isNeutral: json['is_neutral'] == true,
      );
}

@immutable
class ScanResult {
  const ScanResult({
    required this.scanId,
    required this.category,
    required this.role,
    required this.primaryHex,
    required this.colorFamily,
    required this.verdict,
    required this.headline,
    required this.detail,
    required this.newPairings,
    required this.totalComplements,
    this.pattern = 'solid',
    this.confidence = 0,
    this.pairingShare = 0,
    this.duplicates = const [],
    this.unlockedOccasions = const [],
    this.wearWith = const [],
    this.lookForColors = const [],
    this.lookForRoles = const [],
    this.photoUrl,
  });

  final String scanId;
  final String category;
  final String role;
  final String primaryHex;
  final String colorFamily;
  final ScanVerdict verdict;
  final String headline;
  final String detail;
  final int newPairings;
  final int totalComplements;
  final String pattern;
  final double confidence;
  final double pairingShare;
  final List<OwnedMatch> duplicates;
  final List<String> unlockedOccasions;
  final List<WearWith> wearWith;
  final List<ColorOpportunity> lookForColors;
  final List<String> lookForRoles;
  final String? photoUrl;

  factory ScanResult.fromJson(Map<String, dynamic> json) => ScanResult(
        scanId: json['scan_id'].toString(),
        category: (json['category'] ?? '').toString(),
        role: (json['role'] ?? 'base_top').toString(),
        primaryHex: (json['primary_hex'] ?? '#808080').toString(),
        colorFamily: (json['color_family'] ?? '').toString(),
        verdict: ScanVerdict.parse(json['verdict'] as String?),
        headline: (json['headline'] ?? '').toString(),
        detail: (json['detail'] ?? '').toString(),
        newPairings: (json['new_pairings'] as num?)?.toInt() ?? 0,
        totalComplements: (json['total_complements'] as num?)?.toInt() ?? 0,
        pattern: (json['pattern'] ?? 'solid').toString(),
        confidence: _toDouble(json['confidence']) ?? 0,
        pairingShare: _toDouble(json['pairing_share']) ?? 0,
        duplicates: ((json['duplicates'] as List?) ?? const [])
            .map((e) => OwnedMatch.fromJson(e as Map<String, dynamic>))
            .toList(),
        unlockedOccasions: _strings(json['unlocked_occasions']),
        wearWith: ((json['wear_with'] as List?) ?? const [])
            .map((e) => WearWith.fromJson(e as Map<String, dynamic>))
            .toList(),
        lookForColors: ((json['look_for_colors'] as List?) ?? const [])
            .map((e) => ColorOpportunity.fromJson(e as Map<String, dynamic>))
            .toList(),
        lookForRoles: _strings(json['look_for_roles']),
        photoUrl: _as<String>(json['photo_url']),
      );

  int get argb => int.parse('FF${primaryHex.replaceAll('#', '')}', radix: 16);

  String get displayCategory => category.replaceAll('_', ' ');
}
