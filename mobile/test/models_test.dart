import 'package:flutter_test/flutter_test.dart';
import 'package:smartstylist/core/api_exception.dart';
import 'package:smartstylist/models/models.dart';

/// Payloads copied from the API contract (api/openapi/openapi.yaml) so a change
/// on the server that the client cannot parse fails here rather than in the app.
/// Copy a fixture with one field changed. A spread literal cannot be used here:
/// the analyzer would insist on `const`, which forbids the duplicate key.
Map<String, dynamic> _with(Map<String, dynamic> base, String key, Object? value) =>
    Map<String, dynamic>.from(base)..[key] = value;

void main() {
  group('Garment', () {
    const json = {
      'id': 'a1b2',
      'category': 'shirt',
      'category_id': 12,
      'role': 'base_top',
      'name': 'Navy linen shirt',
      'brand': 'Uniqlo',
      'pattern': 'solid',
      'material': ['linen'],
      'fit': 'regular',
      'formality': 4,
      'warmth': 1,
      'seasons': ['spring', 'summer'],
      'colors': [
        {'hex': '#1B2A4A', 'ratio': 0.82, 'color_family': 'navy', 'is_neutral': true},
        {'hex': '#FFFFFF', 'ratio': 0.18, 'color_family': 'white', 'is_neutral': true},
      ],
      'image_url': 'https://example/x.jpg',
      'cutout_url': 'https://example/x.png',
      'ownership': 'owned',
      'in_laundry': false,
      'wear_count': 3,
      'last_worn_at': '2026-09-01',
      'auto_tagged': true,
      'user_verified': false,
      'tag_confidence': 0.87,
      'created_at': '2026-09-13T10:00:00Z',
    };

    test('parses the API payload', () {
      final garment = Garment.fromJson(json);
      expect(garment.displayName, 'Navy linen shirt');
      expect(garment.primaryColor?.family, 'navy');
      expect(garment.primaryColor?.argb, 0xFF1B2A4A);
      expect(garment.seasons, ['spring', 'summer']);
      expect(garment.lastWornAt?.month, 9);
    });

    test('flags auto-tagged items the user has not confirmed', () {
      expect(Garment.fromJson(json).needsConfirmation, isTrue);
      expect(
        Garment.fromJson(_with(json, 'user_verified', true)).needsConfirmation,
        isFalse,
      );
    });

    test('falls back to the category when there is no name', () {
      final garment = Garment.fromJson(_with(json, 'name', null));
      expect(garment.displayName, 'shirt');
    });

    test('survives missing optional fields', () {
      final garment = Garment.fromJson(const {
        'id': 'x',
        'category': 'tee',
        'category_id': 1,
        'role': 'base_top',
        'formality': 2,
        'warmth': 1,
        'colors': <dynamic>[],
        'wear_count': 0,
        'in_laundry': false,
        'auto_tagged': false,
        'user_verified': true,
        'created_at': '2026-01-01T00:00:00Z',
      });
      expect(garment.primaryColor, isNull);
      expect(garment.material, isEmpty);
    });
  });

  group('Outfit', () {
    Map<String, dynamic> item(String role, String id) => {
          'role': role,
          'layer_order': 0,
          'garment': {
            'id': id,
            'category': 'x',
            'category_id': 1,
            'role': role,
            'formality': 3,
            'warmth': 1,
            'colors': <dynamic>[],
            'wear_count': 0,
            'in_laundry': false,
            'auto_tagged': false,
            'user_verified': true,
            'created_at': '2026-01-01T00:00:00Z',
          },
        };

    final json = {
      'id': 'o1',
      'origin': 'ai',
      'total_score': 0.8934,
      'score_breakdown': {
        'color_harmony': 0.91,
        'formality_fit': 0.95,
        'weather_fit': 0.62,
        'completeness': 1.0,
      },
      'rationale': 'Navy with camel — complementary, right for 24°C.',
      'dominant_colors': ['#1B2A4A'],
      'is_favorite': false,
      'created_at': '2026-09-13T10:00:00Z',
      'items': [item('footwear', 'f'), item('base_top', 't'), item('bottom', 'b')],
    };

    test('orders items head to toe for display', () {
      final outfit = Outfit.fromJson(json);
      expect(outfit.orderedItems.map((i) => i.role), ['base_top', 'bottom', 'footwear']);
    });

    test('surfaces the two strongest reasons and hides completeness', () {
      final reasons = Outfit.fromJson(json).topReasons;
      expect(reasons.length, 2);
      expect(reasons.first.key, 'formality_fit');
      expect(reasons.map((e) => e.key), isNot(contains('completeness')));
    });
  });

  group('TryOnJob', () {
    test('tracks running state and layer progress', () {
      final job = TryOnJob.fromJson(const {
        'id': 'j1',
        'status': 'running',
        'model_id': 'composite@1',
        'pass_index': 2,
        'total_passes': 4,
        'poll_after_ms': 1500,
        'queued_at': '2026-09-13T10:00:00Z',
      });
      expect(job.isRunning, isTrue);
      expect(job.isReady, isFalse);
      expect(job.progress, 0.5);
    });

    test('is ready only when a result exists', () {
      final done = TryOnJob.fromJson(const {
        'id': 'j1',
        'status': 'succeeded',
        'model_id': 'composite@1',
        'result_url': 'https://example/r.png',
        'queued_at': '2026-09-13T10:00:00Z',
      });
      expect(done.isReady, isTrue);

      final failed = TryOnJob.fromJson(const {
        'id': 'j2',
        'status': 'failed',
        'model_id': 'composite@1',
        'error_code': 'UnusableBodyPhoto',
        'queued_at': '2026-09-13T10:00:00Z',
      });
      expect(failed.isReady, isFalse);
      expect(failed.isRunning, isFalse);
    });
  });

  group('ApiException', () {
    test('turns a consent problem into an actionable message', () {
      final error = ApiException.fromProblem(403, {
        'type': 'https://api.smartstylist.app/problems/consent-required',
        'title': 'Consent required',
        'status': 403,
        'detail': 'vton_processing consent is required for this operation',
        'required_consent': 'vton_processing',
        'trace_id': 'abc123',
      });
      expect(error.requiredConsent, 'vton_processing');
      expect(error.userMessage, contains('virtual try-on'));
      expect(error.traceId, 'abc123');
    });

    test('exposes the missing roles from an insufficient wardrobe', () {
      final error = ApiException.fromProblem(422, {
        'type': 'https://api.smartstylist.app/problems/insufficient-wardrobe',
        'title': 'Not enough items',
        'status': 422,
        'detail': 'No footwear available',
        'missing_roles': ['footwear'],
      });
      expect(error.missingRoles, ['footwear']);
      expect(error.userMessage, contains('footwear'));
    });

    test('explains a quota problem in the user\'s terms', () {
      final error = ApiException.fromProblem(402, {
        'title': 'Quota exceeded',
        'status': 402,
        'detail': 'Monthly vton_renders quota is exhausted.',
        'metric': 'vton_renders',
      });
      expect(error.isQuotaExceeded, isTrue);
      expect(error.userMessage, contains('try-ons'));
    });

    test('reports a transport failure as a connection problem', () {
      final error = ApiException.network(Exception('socket closed'));
      expect(error.isNetwork, isTrue);
      expect(error.statusCode, 0);
    });
  });

  group('Weather', () {
    test('prefers felt temperature and flags rain', () {
      final weather = Weather.fromJson(const {
        'temp_c': 31.4,
        'feels_like_c': 35.1,
        'precip_prob': 0.6,
        'condition': 'clear',
      });
      expect(weather.effectiveTemp, 35.1);
      expect(weather.isWet, isTrue);
      expect(weather.toJson()['feels_like_c'], 35.1);
    });
  });

  group('DetectionCard', () {
    test('explains why an item needs checking', () {
      expect(
        DetectionCard.fromJson(const {
          'id': 'd',
          'label': 'thing',
          'confidence': 0.3,
          'gate_failures': ['low_confidence'],
        }).reason,
        'Not sure about this one',
      );
      expect(
        DetectionCard.fromJson(const {
          'id': 'd',
          'label': 'thing',
          'confidence': 0.9,
          'gate_failures': ['unmapped_label'],
        }).reason,
        'Unrecognised item',
      );
    });
  });
}
