import 'package:flutter/material.dart';

/// One place for colour, type and spacing.
///
/// The palette is intentionally quiet — near-neutral surfaces with a single
/// accent — because the wardrobe grid is wall-to-wall photographs and any
/// chrome with an opinion fights the garments for attention.
class AppTheme {
  const AppTheme._();

  static const Color _seed = Color(0xFF1B2A4A); // navy, the app's one accent
  static const double gutter = 16;
  static const double radius = 16;

  static ThemeData light() => _build(Brightness.light);
  static ThemeData dark() => _build(Brightness.dark);

  static ThemeData _build(Brightness brightness) {
    final scheme = ColorScheme.fromSeed(seedColor: _seed, brightness: brightness);
    final isDark = brightness == Brightness.dark;

    return ThemeData(
      useMaterial3: true,
      colorScheme: scheme,
      scaffoldBackgroundColor:
          isDark ? const Color(0xFF121316) : const Color(0xFFFAF9F7),
      appBarTheme: AppBarTheme(
        backgroundColor: Colors.transparent,
        surfaceTintColor: Colors.transparent,
        elevation: 0,
        centerTitle: false,
        titleTextStyle: TextStyle(
          fontSize: 22,
          fontWeight: FontWeight.w600,
          letterSpacing: -0.4,
          color: scheme.onSurface,
        ),
      ),
      cardTheme: CardThemeData(
        elevation: 0,
        margin: EdgeInsets.zero,
        color: isDark ? const Color(0xFF1C1E22) : Colors.white,
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(radius)),
      ),
      chipTheme: ChipThemeData(
        side: BorderSide(color: scheme.outlineVariant),
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(999)),
        padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
      ),
      filledButtonTheme: FilledButtonThemeData(
        style: FilledButton.styleFrom(
          minimumSize: const Size.fromHeight(52),
          shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(14)),
          textStyle: const TextStyle(fontSize: 16, fontWeight: FontWeight.w600),
        ),
      ),
      snackBarTheme: SnackBarThemeData(
        behavior: SnackBarBehavior.floating,
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
      ),
      textTheme: const TextTheme(
        headlineSmall: TextStyle(fontWeight: FontWeight.w600, letterSpacing: -0.5),
        titleMedium: TextStyle(fontWeight: FontWeight.w600),
        bodyMedium: TextStyle(height: 1.4),
      ),
    );
  }

  /// Colour families the styling engine speaks, mapped to swatches for chips.
  static Color familySwatch(String family) => switch (family) {
        'black' => const Color(0xFF111111),
        'charcoal' => const Color(0xFF36393F),
        'grey' => const Color(0xFF9AA0A6),
        'white' => const Color(0xFFFFFFFF),
        'cream' => const Color(0xFFF5EFE0),
        'beige' => const Color(0xFFD9C7A7),
        'camel' => const Color(0xFFB08245),
        'brown' => const Color(0xFF6B4A2F),
        'navy' => const Color(0xFF1B2A4A),
        'denim' => const Color(0xFF4A6FA5),
        'blue' => const Color(0xFF2563EB),
        'light_blue' => const Color(0xFFA5C8E8),
        'teal' => const Color(0xFF0F766E),
        'green' => const Color(0xFF16A34A),
        'olive' => const Color(0xFF6B7238),
        'forest' => const Color(0xFF1F3D2B),
        'mustard' => const Color(0xFFC99A2E),
        'yellow' => const Color(0xFFFACC15),
        'orange' => const Color(0xFFF97316),
        'coral' => const Color(0xFFFF7F6B),
        'red' => const Color(0xFFDC2626),
        'burgundy' => const Color(0xFF6E1B2E),
        'pink' => const Color(0xFFEC4899),
        'blush' => const Color(0xFFF3C9C6),
        'purple' => const Color(0xFF7C3AED),
        'lavender' => const Color(0xFFC7B8EA),
        'gold' => const Color(0xFFC9A227),
        'silver' => const Color(0xFFC0C4C8),
        _ => const Color(0xFF9AA0A6),
      };
}

/// Human labels for the vocabularies the API returns.
class Labels {
  const Labels._();

  static String role(String slug) => switch (slug) {
        'base_top' => 'Top',
        'mid_layer' => 'Mid layer',
        'outerwear' => 'Outerwear',
        'bottom' => 'Bottom',
        'full_body' => 'One-piece',
        'footwear' => 'Shoes',
        'headwear' => 'Headwear',
        'other_accessory' => 'Accessory',
        _ => _titleCase(slug),
      };

  static String scoreTerm(String slug) => switch (slug) {
        'color_harmony' => 'Colour harmony',
        'palette_fit' => 'Suits your palette',
        'formality_fit' => 'Right formality',
        'weather_fit' => 'Weather match',
        'pattern_balance' => 'Pattern balance',
        'proportion_fit' => 'Flatters your shape',
        'personal_taste' => 'Your taste',
        'novelty' => 'Something fresh',
        'preference_fit' => 'Your preferences',
        _ => _titleCase(slug),
      };

  static String formality(int level) => switch (level) {
        1 => 'Loungewear',
        2 => 'Casual',
        3 => 'Smart casual',
        4 => 'Business',
        _ => 'Formal',
      };

  static String _titleCase(String slug) {
    final words = slug.replaceAll('_', ' ').split(' ');
    return words
        .map((w) => w.isEmpty ? w : '${w[0].toUpperCase()}${w.substring(1)}')
        .join(' ');
  }
}
