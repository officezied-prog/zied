import 'dart:convert';
import 'dart:typed_data';

import 'package:crypto/crypto.dart';

import '../core/api_client.dart';
import '../models/models.dart';

/// Upload flow: presign, PUT straight to storage, then ask the API to run the
/// vision pipeline. Files the server already has are skipped without transfer.
class UploadRepository {
  UploadRepository(this._api);

  final ApiClient _api;

  Future<List<String>> uploadImages(
    List<Uint8List> images, {
    String purpose = 'wardrobe',
    List<String>? filenames,
    void Function(int done, int total)? onProgress,
  }) async {
    if (images.isEmpty) return const [];

    final files = <Map<String, dynamic>>[];
    for (var i = 0; i < images.length; i++) {
      files.add({
        'filename': filenames?.elementAtOrNull(i) ?? 'photo_$i.jpg',
        'mime_type': 'image/jpeg',
        'byte_size': images[i].length,
        'sha256': sha256.convert(images[i]).toString(),
      });
    }

    final response = await _api.post('/v1/uploads/presign',
        body: {'purpose': purpose, 'files': files},) as Map<String, dynamic>;
    final uploads = (response['uploads'] as List).cast<Map<String, dynamic>>();

    final mediaIds = <String>[];
    var done = 0;
    for (var i = 0; i < uploads.length; i++) {
      final entry = uploads[i];
      final url = entry['upload_url'] as String?;
      if (url != null) {
        await _api.uploadBytes(
          url,
          images[i],
          headers: Map<String, String>.from(
              (entry['headers'] as Map?)?.cast<String, String>() ??
                  {'Content-Type': 'image/jpeg'},),
        );
      }
      mediaIds.add(entry['media_id'] as String);
      onProgress?.call(++done, uploads.length);
    }
    return mediaIds;
  }

  Future<IngestJob> startIngest(List<String> mediaIds,
      {bool autoAccept = true, String? idempotencyKey,}) async {
    final body = {'media_ids': mediaIds, 'auto_accept': autoAccept};
    final json = await _api.post('/v1/ingest/jobs',
        body: body, idempotencyKey: idempotencyKey,) as Map<String, dynamic>;
    return IngestJob.fromJson(json);
  }

  Future<IngestJob> awaitIngest(String jobId,
      {void Function(IngestJob job)? onTick,}) async {
    final json = await _api.pollJob(
      '/v1/ingest/jobs/$jobId',
      onTick: (raw) => onTick?.call(IngestJob.fromJson(raw)),
    );
    return IngestJob.fromJson(json);
  }
}

class WardrobeRepository {
  WardrobeRepository(this._api);

  final ApiClient _api;

  Future<({List<Garment> items, String? nextCursor})> list({
    String? role,
    String? category,
    String? colorFamily,
    String? query,
    bool availableOnly = false,
    String? cursor,
    int limit = 50,
  }) async {
    final json = await _api.get('/v1/garments', query: {
      'role': role,
      'category': category,
      'color_family': colorFamily,
      'q': query,
      if (availableOnly) 'available_only': true,
      'cursor': cursor,
      'limit': limit,
    },) as Map<String, dynamic>;

    return (
      items: (json['items'] as List)
          .map((e) => Garment.fromJson(e as Map<String, dynamic>))
          .toList(),
      nextCursor: json['next_cursor'] as String?,
    );
  }

  Future<Garment> get(String id) async =>
      Garment.fromJson(await _api.get('/v1/garments/$id') as Map<String, dynamic>);

  Future<Garment> update(String id, Map<String, dynamic> patch) async =>
      Garment.fromJson(
          await _api.patch('/v1/garments/$id', body: patch) as Map<String, dynamic>,);

  Future<int> bulkUpdate(List<String> ids, Map<String, dynamic> patch) async {
    final json = await _api.patch('/v1/garments/bulk',
        body: {'ids': ids, 'patch': patch},) as Map<String, dynamic>;
    return (json['updated'] as num).toInt();
  }

  Future<void> delete(String id) => _api.delete('/v1/garments/$id');

  Future<void> logWear(String id) => _api.post('/v1/garments/$id/wear');

  Future<WardrobeStats> stats() async =>
      WardrobeStats.fromJson(await _api.get('/v1/wardrobe/stats') as Map<String, dynamic>);

  Future<List<DetectionCard>> reviewQueue({int limit = 50}) async {
    final json = await _api.get('/v1/detections',
        query: {'status_filter': 'pending', 'limit': limit},) as List;
    return json.map((e) => DetectionCard.fromJson(e as Map<String, dynamic>)).toList();
  }

  Future<void> acceptDetection(String id, {Map<String, dynamic>? corrections}) =>
      _api.post('/v1/detections/$id/accept', body: corrections ?? {});

  Future<void> rejectDetection(String id) => _api.post('/v1/detections/$id/reject');
}

class StylingRepository {
  StylingRepository(this._api);

  final ApiClient _api;

  Future<List<Occasion>> occasions() async {
    final json = await _api.get('/v1/taxonomy/occasions') as List;
    return json.map((e) => Occasion.fromJson(e as Map<String, dynamic>)).toList();
  }

  Future<Weather> weather(double lat, double lon) async =>
      Weather.fromJson(await _api.get('/v1/weather',
          query: {'lat': lat, 'lon': lon},) as Map<String, dynamic>,);

  Future<Recommendation> recommend({
    required String occasion,
    double? lat,
    double? lon,
    Weather? weatherOverride,
    int count = 5,
    List<String> mustInclude = const [],
    List<String> exclude = const [],
  }) async {
    final json = await _api.post('/v1/outfits/recommend', body: {
      'occasion': occasion,
      'count': count,
      if (lat != null && lon != null) 'location': {'lat': lat, 'lon': lon},
      if (weatherOverride != null) 'weather_override': weatherOverride.toJson(),
      if (mustInclude.isNotEmpty) 'must_include_garment_ids': mustInclude,
      if (exclude.isNotEmpty) 'exclude_garment_ids': exclude,
    },) as Map<String, dynamic>;
    return Recommendation.fromJson(json);
  }

  Future<List<Outfit>> saved({bool? favorite}) async {
    final json = await _api.get('/v1/outfits',
        query: {if (favorite != null) 'favorite': favorite},) as Map<String, dynamic>;
    return (json['items'] as List)
        .map((e) => Outfit.fromJson(e as Map<String, dynamic>))
        .toList();
  }

  Future<Outfit> get(String id) async =>
      Outfit.fromJson(await _api.get('/v1/outfits/$id') as Map<String, dynamic>);

  Future<Outfit> setFavorite(String id, {required bool value}) async =>
      Outfit.fromJson(await _api
          .patch('/v1/outfits/$id', body: {'is_favorite': value}) as Map<String, dynamic>,);

  Future<void> feedback(String outfitId, String kind, {String? reason}) =>
      _api.post('/v1/outfits/$outfitId/feedback',
          body: {'kind': kind, if (reason != null) 'reason': reason},);

  Future<List<({Garment garment, double score})>> alternatives(
      String outfitId, String role, {List<String> exclude = const [],}) async {
    final json = await _api.post('/v1/outfits/$outfitId/swap', body: {
      'role': role,
      if (exclude.isNotEmpty) 'exclude_garment_ids': exclude,
    },) as List;
    return json
        .map((e) => (
              garment: Garment.fromJson((e as Map<String, dynamic>)['garment'] as Map<String, dynamic>),
              score: (e['score'] as num).toDouble(),
            ),)
        .toList();
  }
}

class TryOnRepository {
  TryOnRepository(this._api);

  final ApiClient _api;

  Future<List<BodyPhoto>> bodyPhotos() async {
    final json = await _api.get('/v1/me/body-photos') as List;
    return json.map((e) => BodyPhoto.fromJson(e as Map<String, dynamic>)).toList();
  }

  Future<BodyPhoto> registerBodyPhoto(String mediaId, {String pose = 'front_full'}) async =>
      BodyPhoto.fromJson(await _api.post('/v1/me/body-photos',
          body: {'media_id': mediaId, 'pose': pose, 'is_primary': true},)
          as Map<String, dynamic>,);

  Future<void> deleteBodyPhoto(String id) => _api.delete('/v1/me/body-photos/$id');

  Future<TryOnJob> start({
    String? outfitId,
    List<String> garmentIds = const [],
    String? bodyPhotoId,
    String? modelId,
    String? idempotencyKey,
  }) async {
    final json = await _api.post('/v1/vton/jobs',
        idempotencyKey: idempotencyKey,
        body: {
          if (outfitId != null) 'outfit_id': outfitId,
          if (garmentIds.isNotEmpty) 'garment_ids': garmentIds,
          if (bodyPhotoId != null) 'body_photo_id': bodyPhotoId,
          if (modelId != null) 'model_id': modelId,
        },) as Map<String, dynamic>;
    return TryOnJob.fromJson(json);
  }

  Future<TryOnJob> awaitResult(String jobId, {void Function(TryOnJob)? onTick}) async {
    final json = await _api.pollJob(
      '/v1/vton/jobs/$jobId',
      onTick: (raw) => onTick?.call(TryOnJob.fromJson(raw)),
    );
    return TryOnJob.fromJson(json);
  }

  Future<void> cancel(String jobId) => _api.delete('/v1/vton/jobs/$jobId');
}

class AccountRepository {
  AccountRepository(this._api);

  final ApiClient _api;

  Future<Map<String, bool>> consents() async {
    final json = await _api.get('/v1/me/consents') as List;
    return {
      for (final e in json.cast<Map<String, dynamic>>())
        e['consent_type'] as String: e['granted'] == true,
    };
  }

  Future<void> setConsent(String type, {required bool granted}) => _api.post(
        '/v1/me/consents',
        body: {
          'consent_type': type,
          'granted': granted,
          'policy_version': policyVersion,
        },
      );

  Future<Map<String, dynamic>> me() async =>
      await _api.get('/v1/me') as Map<String, dynamic>;

  static const String policyVersion = 'privacy-2026-04-01';
}

/// Small helper mirrored from the server so uploads can be deduplicated client
/// side before the presign call, saving a round trip on re-imports.
String sha256Hex(Uint8List bytes) => sha256.convert(bytes).toString();

String base64Preview(Uint8List bytes) => base64Encode(bytes.take(64).toList());
