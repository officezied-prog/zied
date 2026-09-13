import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:smartstylist/core/api_client.dart';
import 'package:smartstylist/core/theme.dart';
import 'package:smartstylist/providers/providers.dart';
import 'package:smartstylist/screens/event_selector_screen.dart';
import 'package:smartstylist/screens/outfit_results_screen.dart';
import 'package:smartstylist/screens/profile_screen.dart';
import 'package:smartstylist/screens/wardrobe_screen.dart';

/// Widget tests drive the real providers and repositories over a stubbed
/// transport, so a screen breaking because of a contract change is caught here.
ProviderScope _app(Widget child, Map<String, Object> routes) {
  final client = ApiClient(
    baseUrl: 'http://test',
    httpClient: MockClient((request) async {
      final path = request.url.path;
      final match = routes.entries.firstWhere(
        (entry) => path.startsWith(entry.key),
        orElse: () => const MapEntry('', <String, dynamic>{}),
      );
      return http.Response(
        jsonEncode(match.value),
        200,
        headers: {'content-type': 'application/json'},
      );
    }),
  );

  return ProviderScope(
    overrides: [apiClientProvider.overrideWithValue(client)],
    child: MaterialApp(theme: AppTheme.light(), home: child),
  );
}

Map<String, dynamic> _garment(String id, String name, String role, String family) => {
      'id': id,
      'category': 'shirt',
      'category_id': 1,
      'role': role,
      'name': name,
      'pattern': 'solid',
      'material': <String>[],
      'fit': 'regular',
      'formality': 3,
      'warmth': 1,
      'seasons': <String>[],
      'colors': [
        {'hex': '#1B2A4A', 'ratio': 0.9, 'color_family': family, 'is_neutral': true},
      ],
      'ownership': 'owned',
      'in_laundry': false,
      'wear_count': 0,
      'auto_tagged': true,
      'user_verified': false,
      'created_at': '2026-09-13T10:00:00Z',
    };

void main() {
  testWidgets('wardrobe shows an onboarding empty state, not a blank screen',
      (tester) async {
    await tester.pumpWidget(_app(const WardrobeScreen(), {
      '/v1/garments': {'items': <dynamic>[], 'next_cursor': null},
      '/v1/detections': <dynamic>[],
      '/v1/wardrobe/stats': {'items': 0, 'never_worn': 0, 'worn_last_30d': 0,
                             'by_role': <String, int>{}, 'gaps': <String>[],},
    }),);
    await tester.pumpAndSettle();

    expect(find.text('Your wardrobe is empty'), findsOneWidget);
    expect(find.text('Add photos'), findsWidgets);
  });

  testWidgets('wardrobe renders garments and marks unconfirmed items',
      (tester) async {
    await tester.pumpWidget(_app(const WardrobeScreen(), {
      '/v1/garments': {
        'items': [
          _garment('g1', 'Navy shirt', 'base_top', 'navy'),
          _garment('g2', 'Camel chinos', 'bottom', 'camel'),
        ],
        'next_cursor': null,
      },
      '/v1/detections': <dynamic>[],
    }),);
    await tester.pumpAndSettle();

    expect(find.text('Navy shirt'), findsOneWidget);
    expect(find.text('Camel chinos'), findsOneWidget);
    expect(find.text('Check'), findsNWidgets(2)); // auto-tagged, unconfirmed
    expect(find.text('unworn'), findsNWidgets(2));
  });

  testWidgets('review badge appears only when something needs checking',
      (tester) async {
    await tester.pumpWidget(_app(const WardrobeScreen(), {
      '/v1/garments': {'items': <dynamic>[], 'next_cursor': null},
      '/v1/detections': [
        {'id': 'd1', 'label': 'thing', 'confidence': 0.4,
         'gate_failures': ['low_confidence'],},
      ],
    }),);
    await tester.pumpAndSettle();
    expect(find.byIcon(Icons.fact_check_outlined), findsOneWidget);
  });

  testWidgets('occasion grid disables "Style me" until one is chosen',
      (tester) async {
    await tester.pumpWidget(_app(const EventSelectorScreen(), {
      '/v1/taxonomy/occasions': [
        {'id': 1, 'slug': 'date_night', 'display_name': 'Date Night',
         'formality_min': 3, 'formality_max': 5, 'is_custom': false,},
        {'id': 2, 'slug': 'business_meeting', 'display_name': 'Business Meeting',
         'formality_min': 4, 'formality_max': 5, 'is_custom': false,},
      ],
    }),);
    await tester.pumpAndSettle();

    expect(find.text('Date Night'), findsOneWidget);
    final button = tester.widget<FilledButton>(find.byType(FilledButton));
    expect(button.onPressed, isNull, reason: 'nothing selected yet');

    await tester.tap(find.text('Date Night'));
    await tester.pumpAndSettle();
    expect(tester.widget<FilledButton>(find.byType(FilledButton)).onPressed, isNotNull);
  });

  testWidgets('results screen shows the rationale and the top two reasons',
      (tester) async {
    final outfit = {
      'id': 'o1',
      'origin': 'ai',
      'total_score': 0.89,
      'score_breakdown': {
        'color_harmony': 0.91,
        'formality_fit': 0.95,
        'novelty': 0.42,
        'completeness': 1.0,
      },
      'rationale': 'Navy with camel — complementary, right for 24°C.',
      'dominant_colors': <String>[],
      'is_favorite': false,
      'created_at': '2026-09-13T10:00:00Z',
      'items': [
        {'role': 'base_top', 'layer_order': 0,
         'garment': _garment('g1', 'Navy shirt', 'base_top', 'navy'),},
        {'role': 'bottom', 'layer_order': 0,
         'garment': _garment('g2', 'Camel chinos', 'bottom', 'camel'),},
      ],
    };

    final container = ProviderContainer(overrides: [
      apiClientProvider.overrideWithValue(ApiClient(
        baseUrl: 'http://test',
        httpClient: MockClient((_) async => http.Response(
              jsonEncode({
                'run_id': 'r1',
                'engine_version': 'styling-1.0.0',
                'candidate_count': 218,
                'latency_ms': 640,
                'weather': {'temp_c': 24.0, 'feels_like_c': 24.0, 'precip_prob': 0.0,
                            'condition': 'clear',},
                'outfits': [outfit],
              }),
              200,
              headers: {'content-type': 'application/json'},
            ),),
      ),),
    ],);
    addTearDown(container.dispose);

    await container
        .read(recommendationProvider.notifier)
        .run(occasion: 'date_night');

    await tester.pumpWidget(UncontrolledProviderScope(
      container: container,
      child: const MaterialApp(home: OutfitResultsScreen(occasion: 'date_night')),
    ),);
    await tester.pumpAndSettle();

    expect(find.textContaining('complementary'), findsOneWidget);
    expect(find.text('Right formality'), findsOneWidget);
    expect(find.text('Colour harmony'), findsOneWidget);
    expect(find.text('Something fresh'), findsNothing, reason: 'only the top two');
    // The pill shows the temperature; the rationale mentions it too, so match
    // the pill exactly rather than any text containing it.
    expect(find.text('24°C'), findsOneWidget);
    expect(find.textContaining('218 pieces considered'), findsOneWidget);
  });

  testWidgets('profile lists every permission as a separate switch',
      (tester) async {
    await tester.pumpWidget(_app(const ProfileScreen(), {
      '/v1/wardrobe/stats': {'items': 42, 'never_worn': 7, 'worn_last_30d': 12,
                             'by_role': {'base_top': 10}, 'gaps': <String>[],},
      '/v1/me/consents': [
        {'consent_type': 'vton_processing', 'granted': true,
         'policy_version': 'p', 'decided_at': '2026-09-13T10:00:00Z',},
      ],
    }),);
    await tester.pumpAndSettle();

    expect(find.text('42'), findsOneWidget);
    expect(find.text('Virtual try-on'), findsOneWidget);
    expect(find.text('Body measurements'), findsOneWidget);
    expect(find.byType(SwitchListTile), findsNWidgets(4));

    final vtonSwitch = tester.widget<SwitchListTile>(
      find.ancestor(
        of: find.text('Virtual try-on'),
        matching: find.byType(SwitchListTile),
      ),
    );
    expect(vtonSwitch.value, isTrue);
  });
}
