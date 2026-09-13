/// Build-time configuration.
///
/// Supplied with `--dart-define`, never committed:
///   flutter run --dart-define=SS_API_BASE_URL=https://api.smartstylist.app
class AppConfig {
  const AppConfig._();

  static const String apiBaseUrl = String.fromEnvironment(
    'SS_API_BASE_URL',
    defaultValue: 'http://10.0.2.2:8000', // Android emulator -> host machine
  );

  /// Development only: lets the app talk to a local API without a real IdP.
  static const String devToken = String.fromEnvironment('SS_DEV_TOKEN');

  /// Runs the app against a fixed in-memory wardrobe instead of a server.
  ///
  /// Built for showing the app without standing up the backend — a browser
  /// build, a design review, store screenshots. Every screen is real; only the
  /// transport is replaced, and the app says so in a banner so nobody mistakes
  /// the sample closet for their own.
  ///
  ///   flutter run --dart-define=SS_DEMO=true
  static const bool demoMode = bool.fromEnvironment('SS_DEMO');

  static const Duration requestTimeout = Duration(seconds: 30);
  static const Duration uploadTimeout = Duration(minutes: 2);

  /// Long-poll cadence for async jobs. The server also returns `poll_after_ms`,
  /// which always wins when present.
  static const Duration defaultPollInterval = Duration(seconds: 2);
  static const Duration maxPollDuration = Duration(minutes: 3);

  /// Downscale before upload: the server caps at 2048 anyway, and a 12 MP photo
  /// over a mobile connection is the slowest part of onboarding.
  static const int maxUploadDimension = 2048;
  static const int uploadQuality = 88;
  static const int uploadBatchSize = 10;
}
