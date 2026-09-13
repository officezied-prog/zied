import 'dart:async';
import 'dart:convert';
import 'dart:typed_data';

import 'package:http/http.dart' as http;

import 'api_exception.dart';
import 'config.dart';

/// Thin, typed transport over the SmartStylist REST API.
///
/// Three responsibilities and nothing else: attach the bearer token, turn
/// non-2xx problem documents into [ApiException], and expose the async-job
/// polling loop the server's `202 + poll_after_ms` contract expects.
class ApiClient {
  ApiClient({
    http.Client? httpClient,
    String? baseUrl,
    Future<String?> Function()? tokenProvider,
    Future<void> Function()? onUnauthorized,
  })  : _http = httpClient ?? http.Client(),
        _baseUrl = baseUrl ?? AppConfig.apiBaseUrl,
        _tokenProvider = tokenProvider,
        _onUnauthorized = onUnauthorized;

  final http.Client _http;
  final String _baseUrl;
  final Future<String?> Function()? _tokenProvider;
  final Future<void> Function()? _onUnauthorized;

  void close() => _http.close();

  Future<Map<String, String>> _headers({bool json = true}) async {
    final token = await _tokenProvider?.call();
    return {
      if (json) 'Content-Type': 'application/json',
      'Accept': 'application/json',
      if (token != null && token.isNotEmpty) 'Authorization': 'Bearer $token',
    };
  }

  Uri _uri(String path, [Map<String, dynamic>? query]) {
    final cleaned = query?.entries
        .where((e) => e.value != null)
        .map((e) => MapEntry(e.key, '${e.value}'));
    return Uri.parse('$_baseUrl$path').replace(
      queryParameters: cleaned == null || cleaned.isEmpty
          ? null
          : Map.fromEntries(cleaned),
    );
  }

  Future<dynamic> get(String path, {Map<String, dynamic>? query}) =>
      _send(() async => _http.get(_uri(path, query), headers: await _headers()));

  Future<dynamic> post(String path, {Object? body, String? idempotencyKey}) =>
      _send(() async {
        final headers = await _headers();
        if (idempotencyKey != null) headers['Idempotency-Key'] = idempotencyKey;
        return _http.post(_uri(path), headers: headers, body: jsonEncode(body ?? {}));
      });

  Future<dynamic> patch(String path, {Object? body}) => _send(() async =>
      _http.patch(_uri(path), headers: await _headers(), body: jsonEncode(body ?? {})),);

  Future<dynamic> put(String path, {Object? body}) => _send(() async =>
      _http.put(_uri(path), headers: await _headers(), body: jsonEncode(body ?? {})),);

  Future<void> delete(String path) async {
    await _send(() async => _http.delete(_uri(path), headers: await _headers()));
  }

  /// Uploads bytes straight to object storage using a presigned URL.
  /// Never routed through the API — that is the whole point of presigning.
  Future<void> uploadBytes(
    String presignedUrl,
    Uint8List bytes, {
    required Map<String, String> headers,
  }) async {
    final response = await _http
        .put(Uri.parse(presignedUrl), headers: headers, body: bytes)
        .timeout(AppConfig.uploadTimeout);
    if (response.statusCode >= 300) {
      throw ApiException(
        statusCode: response.statusCode,
        title: 'Upload failed',
        detail: 'Storage rejected the upload (${response.statusCode}).',
        type: 'upload-failed',
      );
    }
  }

  Future<dynamic> _send(Future<http.Response> Function() request) async {
    late http.Response response;
    try {
      response = await request().timeout(AppConfig.requestTimeout);
    } on TimeoutException catch (error) {
      throw ApiException.network(error);
    } catch (error) {
      throw ApiException.network(error);
    }

    if (response.statusCode == 401) {
      await _onUnauthorized?.call();
    }
    if (response.statusCode >= 400) {
      Map<String, dynamic> body;
      try {
        body = jsonDecode(utf8.decode(response.bodyBytes)) as Map<String, dynamic>;
      } catch (_) {
        body = {'title': 'Request failed', 'detail': response.reasonPhrase ?? ''};
      }
      throw ApiException.fromProblem(response.statusCode, body);
    }
    if (response.statusCode == 204 || response.bodyBytes.isEmpty) return null;
    return jsonDecode(utf8.decode(response.bodyBytes));
  }

  /// Polls an async job until it leaves a running state.
  ///
  /// Honours the server's `poll_after_ms` rather than guessing an interval, and
  /// gives up after [AppConfig.maxPollDuration] so a wedged job cannot hold the
  /// UI (and the user's battery) forever.
  Future<Map<String, dynamic>> pollJob(
    String path, {
    bool Function(Map<String, dynamic> job)? isDone,
    void Function(Map<String, dynamic> job)? onTick,
  }) async {
    final deadline = DateTime.now().add(AppConfig.maxPollDuration);
    var wait = AppConfig.defaultPollInterval;

    while (true) {
      final job = (await get(path)) as Map<String, dynamic>;
      onTick?.call(job);

      final done = isDone?.call(job) ??
          !const ['queued', 'running'].contains(job['status']);
      if (done) return job;

      if (DateTime.now().isAfter(deadline)) {
        throw ApiException(
          statusCode: 504,
          title: 'Still working',
          detail: 'This is taking longer than usual. We will notify you when it is ready.',
          type: 'poll-timeout',
          extra: {'job': job},
        );
      }

      final hint = job['poll_after_ms'];
      if (hint is int && hint > 0) wait = Duration(milliseconds: hint);
      await Future<void>.delayed(wait);
    }
  }
}
