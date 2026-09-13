import 'package:cached_network_image/cached_network_image.dart';
import 'package:flutter/material.dart';

import '../core/api_exception.dart';
import '../core/theme.dart';
import '../models/models.dart';

/// Renders an API failure as something a person can act on.
///
/// The server encodes *why* in the problem document, so this never shows a bare
/// "something went wrong": a missing consent offers to grant it, an exhausted
/// quota says when it resets, a network error offers retry.
class ErrorView extends StatelessWidget {
  const ErrorView({super.key, required this.error, this.onRetry, this.onGrantConsent});

  final Object error;
  final VoidCallback? onRetry;
  final void Function(String consent)? onGrantConsent;

  @override
  Widget build(BuildContext context) {
    final problem = error is ApiException ? error as ApiException : null;
    final consent = problem?.requiredConsent;

    return Center(
      child: Padding(
        padding: const EdgeInsets.all(AppTheme.gutter * 2),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(
              problem?.isNetwork == true ? Icons.wifi_off : Icons.error_outline,
              size: 40,
              color: Theme.of(context).colorScheme.outline,
            ),
            const SizedBox(height: 12),
            Text(
              problem?.userMessage ?? 'Something went wrong.',
              textAlign: TextAlign.center,
              style: Theme.of(context).textTheme.bodyLarge,
            ),
            if (problem?.traceId != null) ...[
              const SizedBox(height: 6),
              Text(
                'Reference ${problem!.traceId}',
                style: Theme.of(context).textTheme.bodySmall,
              ),
            ],
            const SizedBox(height: 20),
            if (consent != null && onGrantConsent != null)
              FilledButton(
                onPressed: () => onGrantConsent!(consent),
                child: const Text('Give permission'),
              )
            else if (onRetry != null)
              OutlinedButton.icon(
                onPressed: onRetry,
                icon: const Icon(Icons.refresh),
                label: const Text('Try again'),
              ),
          ],
        ),
      ),
    );
  }
}

class EmptyState extends StatelessWidget {
  const EmptyState({
    super.key,
    required this.icon,
    required this.title,
    required this.message,
    this.action,
  });

  final IconData icon;
  final String title;
  final String message;
  final Widget? action;

  @override
  Widget build(BuildContext context) {
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(AppTheme.gutter * 2),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(icon, size: 44, color: Theme.of(context).colorScheme.outlineVariant),
            const SizedBox(height: 14),
            Text(title, style: Theme.of(context).textTheme.titleMedium),
            const SizedBox(height: 6),
            Text(
              message,
              textAlign: TextAlign.center,
              style: Theme.of(context).textTheme.bodyMedium?.copyWith(
                    color: Theme.of(context).colorScheme.onSurfaceVariant,
                  ),
            ),
            if (action != null) ...[const SizedBox(height: 20), action!],
          ],
        ),
      ),
    );
  }
}

/// A garment thumbnail. Prefers the transparent cutout — a wardrobe of cutouts
/// reads as a wardrobe; a wardrobe of full photos reads as a camera roll.
class GarmentImage extends StatelessWidget {
  const GarmentImage({super.key, required this.garment, this.fit = BoxFit.contain});

  final Garment garment;
  final BoxFit fit;

  @override
  Widget build(BuildContext context) {
    final url = garment.cutoutUrl ?? garment.imageUrl;
    if (url == null) {
      return ColoredBox(
        color: Theme.of(context).colorScheme.surfaceContainerHighest,
        child: const Center(child: Icon(Icons.checkroom, size: 28)),
      );
    }
    return CachedNetworkImage(
      imageUrl: url,
      fit: fit,
      fadeInDuration: const Duration(milliseconds: 150),
      placeholder: (context, _) => ColoredBox(
        color: Theme.of(context).colorScheme.surfaceContainerHighest,
      ),
      errorWidget: (context, _, __) => const Center(child: Icon(Icons.broken_image_outlined)),
    );
  }
}

class ColorDot extends StatelessWidget {
  const ColorDot({super.key, required this.family, this.size = 12});

  final String family;
  final double size;

  @override
  Widget build(BuildContext context) {
    return Container(
      width: size,
      height: size,
      decoration: BoxDecoration(
        color: AppTheme.familySwatch(family),
        shape: BoxShape.circle,
        border: Border.all(color: Theme.of(context).colorScheme.outlineVariant),
      ),
    );
  }
}

/// One row of the "why this outfit" breakdown.
class ScoreBar extends StatelessWidget {
  const ScoreBar({super.key, required this.label, required this.value});

  final String label;
  final double value;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 5),
      child: Row(
        children: [
          SizedBox(
            width: 150,
            child: Text(label, style: Theme.of(context).textTheme.bodySmall),
          ),
          Expanded(
            child: ClipRRect(
              borderRadius: BorderRadius.circular(999),
              child: LinearProgressIndicator(
                value: value.clamp(0, 1),
                minHeight: 6,
                backgroundColor: scheme.surfaceContainerHighest,
                valueColor: AlwaysStoppedAnimation(
                  value >= 0.75
                      ? scheme.primary
                      : value >= 0.5
                          ? scheme.tertiary
                          : scheme.outline,
                ),
              ),
            ),
          ),
          const SizedBox(width: 10),
          SizedBox(
            width: 34,
            child: Text(
              '${(value * 100).round()}',
              textAlign: TextAlign.end,
              style: Theme.of(context).textTheme.bodySmall,
            ),
          ),
        ],
      ),
    );
  }
}

class WeatherPill extends StatelessWidget {
  const WeatherPill({super.key, required this.weather});

  final Weather weather;

  @override
  Widget build(BuildContext context) {
    final icon = switch (weather.condition) {
      'rain' || 'drizzle' => Icons.umbrella_outlined,
      'snow' => Icons.ac_unit,
      'clouds' => Icons.cloud_outlined,
      'storm' || 'thunderstorm' => Icons.thunderstorm_outlined,
      _ => Icons.wb_sunny_outlined,
    };
    return Chip(
      avatar: Icon(icon, size: 18),
      label: Text(
        '${weather.effectiveTemp.round()}°C'
        '${weather.isWet ? ' · rain likely' : ''}',
      ),
    );
  }
}

Future<bool> confirmDialog(BuildContext context,
    {required String title, required String message, String confirmLabel = 'Delete',}) async {
  final result = await showDialog<bool>(
    context: context,
    builder: (context) => AlertDialog(
      title: Text(title),
      content: Text(message),
      actions: [
        TextButton(
          onPressed: () => Navigator.of(context).pop(false),
          child: const Text('Cancel'),
        ),
        FilledButton(
          onPressed: () => Navigator.of(context).pop(true),
          child: Text(confirmLabel),
        ),
      ],
    ),
  );
  return result ?? false;
}

void showMessage(BuildContext context, String message) {
  ScaffoldMessenger.of(context)
    ..hideCurrentSnackBar()
    ..showSnackBar(SnackBar(content: Text(message)));
}
