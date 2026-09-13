import 'dart:convert';
import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:smartstylist/core/api_client.dart';
import 'package:smartstylist/core/api_exception.dart';

http.Response _json(Object body, {int status = 200}) => http.Response(
      jsonEncode(body),
      status,
      headers: {'content-type': 'application/json'},
    );

void main() {
  group('ApiClient', () {
    test('attaches the bearer token', () async {
      String? seen;
      final client = ApiClient(
        baseUrl: 'http://test',
        tokenProvider: () async => 'tok-123',
        httpClient: MockClient((request) async {
          seen = request.headers['Authorization'];
          return _json({'ok': true});
        }),
      );
      await client.get('/v1/me');
      expect(seen, 'Bearer tok-123');
    });

    test('passes the idempotency key through on job creation', () async {
      String? seen;
      final client = ApiClient(
        baseUrl: 'http://test',
        httpClient: MockClient((request) async {
          seen = request.headers['Idempotency-Key'];
          return _json({'id': 'j'}, status: 202);
        }),
      );
      await client.post('/v1/vton/jobs', body: {}, idempotencyKey: 'abc');
      expect(seen, 'abc');
    });

    test('turns a problem document into a typed exception', () async {
      final client = ApiClient(
        baseUrl: 'http://test',
        httpClient: MockClient((_) async => _json({
              'type': 'https://api.smartstylist.app/problems/consent-required',
              'title': 'Consent required',
              'status': 403,
              'detail': 'vton_processing consent is required',
              'required_consent': 'vton_processing',
            }, status: 403,),),
      );

      await expectLater(
        client.get('/v1/me/body-photos'),
        throwsA(isA<ApiException>()
            .having((e) => e.statusCode, 'status', 403)
            .having((e) => e.requiredConsent, 'consent', 'vton_processing'),),
      );
    });

    test('signs the user out on 401 exactly once', () async {
      var signOuts = 0;
      final client = ApiClient(
        baseUrl: 'http://test',
        onUnauthorized: () async => signOuts++,
        httpClient: MockClient((_) async => _json({'title': 'nope'}, status: 401)),
      );
      await expectLater(client.get('/v1/me'), throwsA(isA<ApiException>()));
      expect(signOuts, 1);
    });

    test('reports transport failures as network errors, not crashes', () async {
      final client = ApiClient(
        baseUrl: 'http://test',
        httpClient: MockClient((_) async => throw const SocketishError()),
      );
      await expectLater(
        client.get('/v1/garments'),
        throwsA(isA<ApiException>().having((e) => e.isNetwork, 'isNetwork', true)),
      );
    });

    test('returns null for 204 responses', () async {
      final client = ApiClient(
        baseUrl: 'http://test',
        httpClient: MockClient((_) async => http.Response('', 204)),
      );
      expect(await client.get('/v1/x'), isNull);
    });

    test('omits null query parameters', () async {
      Uri? seen;
      final client = ApiClient(
        baseUrl: 'http://test',
        httpClient: MockClient((request) async {
          seen = request.url;
          return _json({'items': <dynamic>[]});
        }),
      );
      await client.get('/v1/garments', query: {'role': 'base_top', 'q': null});
      expect(seen!.queryParameters, {'role': 'base_top'});
    });

    test('uploads bytes straight to the presigned URL', () async {
      Uint8List? uploaded;
      String? method;
      final client = ApiClient(
        baseUrl: 'http://test',
        httpClient: MockClient((request) async {
          method = request.method;
          uploaded = request.bodyBytes;
          return http.Response('', 200);
        }),
      );
      await client.uploadBytes(
        'http://storage/put',
        Uint8List.fromList([1, 2, 3]),
        headers: {'Content-Type': 'image/jpeg'},
      );
      expect(method, 'PUT');
      expect(uploaded, [1, 2, 3]);
    });

    test('surfaces a storage rejection instead of silently succeeding', () async {
      final client = ApiClient(
        baseUrl: 'http://test',
        httpClient: MockClient((_) async => http.Response('denied', 403)),
      );
      await expectLater(
        client.uploadBytes('http://storage/put', Uint8List(0), headers: const {}),
        throwsA(isA<ApiException>().having((e) => e.type, 'type', 'upload-failed')),
      );
    });
  });

  group('pollJob', () {
    test('follows the server\'s poll_after_ms until the job finishes', () async {
      final states = [
        {'status': 'queued', 'poll_after_ms': 1},
        {'status': 'running', 'pass_index': 1, 'poll_after_ms': 1},
        {'status': 'succeeded', 'result_url': 'http://x/r.png', 'poll_after_ms': 0},
      ];
      var call = 0;
      final ticks = <String>[];

      final client = ApiClient(
        baseUrl: 'http://test',
        httpClient: MockClient((_) async {
          final state = states[call.clamp(0, states.length - 1)];
          call++;
          return _json(state);
        }),
      );

      final result = await client.pollJob(
        '/v1/vton/jobs/j1',
        onTick: (job) => ticks.add(job['status'] as String),
      );

      expect(result['status'], 'succeeded');
      expect(ticks, ['queued', 'running', 'succeeded']);
      expect(call, 3);
    });

    test('stops immediately when the first read is already done', () async {
      var calls = 0;
      final client = ApiClient(
        baseUrl: 'http://test',
        httpClient: MockClient((_) async {
          calls++;
          return _json({'status': 'succeeded'});
        }),
      );
      await client.pollJob('/v1/ingest/jobs/j');
      expect(calls, 1);
    });
  });
}

class SocketishError implements Exception {
  const SocketishError();
  @override
  String toString() => 'connection reset';
}
