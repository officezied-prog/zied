/// A parsed RFC 9457 problem document.
///
/// The API encodes domain outcomes in `type` plus extra members
/// (`required_consent`, `missing_roles`, `metric`), so the UI can react
/// precisely instead of showing one generic error for everything.
class ApiException implements Exception {
  ApiException({
    required this.statusCode,
    required this.title,
    required this.detail,
    this.type = '',
    this.traceId,
    this.extra = const <String, dynamic>{},
  });

  final int statusCode;
  final String title;
  final String detail;
  final String type;
  final String? traceId;
  final Map<String, dynamic> extra;

  factory ApiException.fromProblem(int statusCode, Map<String, dynamic> body) {
    const known = {'type', 'title', 'status', 'detail', 'instance', 'trace_id'};
    return ApiException(
      statusCode: statusCode,
      title: (body['title'] ?? 'Request failed').toString(),
      detail: (body['detail'] ?? '').toString(),
      type: (body['type'] ?? '').toString(),
      traceId: body['trace_id']?.toString(),
      extra: {
        for (final entry in body.entries)
          if (!known.contains(entry.key)) entry.key: entry.value,
      },
    );
  }

  factory ApiException.network(Object error) => ApiException(
        statusCode: 0,
        title: 'No connection',
        detail: 'Could not reach SmartStylist. Check your connection.',
        type: 'network',
        extra: {'cause': error.toString()},
      );

  bool get isNetwork => statusCode == 0;
  bool get isUnauthorized => statusCode == 401;
  bool get isQuotaExceeded => statusCode == 402;

  /// Set when the server refused because a consent is missing or withdrawn.
  String? get requiredConsent => extra['required_consent'] as String?;

  /// Set when the wardrobe cannot produce an outfit for the chosen occasion.
  List<String> get missingRoles =>
      (extra['missing_roles'] as List?)?.map((e) => e.toString()).toList() ?? const [];

  /// A sentence safe to put in front of a user.
  String get userMessage {
    if (isNetwork) return detail;
    if (requiredConsent != null) {
      return 'This needs your permission first (${_prettyConsent(requiredConsent!)}).';
    }
    if (isQuotaExceeded) return 'You have used all of this month\'s try-ons.';
    if (missingRoles.isNotEmpty) {
      return 'Your wardrobe is missing: ${missingRoles.join(', ')}.';
    }
    return detail.isNotEmpty ? detail : title;
  }

  static String _prettyConsent(String slug) =>
      slug.replaceAll('_', ' ').replaceAll('vton', 'virtual try-on');

  @override
  String toString() => 'ApiException($statusCode, $type): $detail';
}
