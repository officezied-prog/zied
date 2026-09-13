import 'dart:typed_data';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:image_picker/image_picker.dart';

import '../core/config.dart';
import '../core/theme.dart';
import '../models/models.dart';
import '../providers/providers.dart';
import '../widgets/common.dart';

/// Virtual try-on.
///
/// Three states, in order: no consent, no body photo, render. Each is a
/// deliberate step — the body photo is the most sensitive thing the product
/// ever asks for, so the screen explains what happens to it before asking.
class TryOnScreen extends ConsumerWidget {
  const TryOnScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final consents = ref.watch(consentsProvider);

    return Scaffold(
      appBar: AppBar(title: const Text('Try on')),
      body: consents.when(
        loading: () => const Center(child: CircularProgressIndicator()),
        error: (error, _) =>
            ErrorView(error: error, onRetry: () => ref.invalidate(consentsProvider)),
        data: (map) => (map['vton_processing'] ?? false)
            ? const _BodyPhotoGate()
            : const _ConsentGate(),
      ),
    );
  }
}

class _ConsentGate extends ConsumerWidget {
  const _ConsentGate();

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    return Padding(
      padding: const EdgeInsets.all(AppTheme.gutter * 1.5),
      child: Column(
        mainAxisAlignment: MainAxisAlignment.center,
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Icon(Icons.privacy_tip_outlined,
              size: 40, color: Theme.of(context).colorScheme.primary,),
          const SizedBox(height: 16),
          Text('Before we show clothes on you',
              style: Theme.of(context).textTheme.headlineSmall,),
          const SizedBox(height: 12),
          const Text(
            'Virtual try-on needs a photo of you. Here is exactly what that means:',
          ),
          const SizedBox(height: 14),
          const _Bullet('Your photo is stored encrypted and is never public.'),
          const _Bullet('Only you can see the renders — links expire in minutes.'),
          const _Bullet('Your face is copied through untouched, never regenerated.'),
          const _Bullet('Withdraw permission any time and every photo and render '
              'is deleted immediately.'),
          const SizedBox(height: 28),
          FilledButton(
            onPressed: () async {
              await ref
                  .read(accountRepositoryProvider)
                  .setConsent('vton_processing', granted: true);
              ref.invalidate(consentsProvider);
            },
            child: const Text('I agree — continue'),
          ),
        ],
      ),
    );
  }
}

class _Bullet extends StatelessWidget {
  const _Bullet(this.text);

  final String text;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.only(bottom: 8),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          const Padding(
            padding: EdgeInsets.only(top: 5, right: 10),
            child: Icon(Icons.check_circle_outline, size: 16),
          ),
          Expanded(child: Text(text, style: Theme.of(context).textTheme.bodyMedium)),
        ],
      ),
    );
  }
}

class _BodyPhotoGate extends ConsumerWidget {
  const _BodyPhotoGate();

  Future<void> _capture(BuildContext context, WidgetRef ref, ImageSource source) async {
    final picked = await ImagePicker().pickImage(
      source: source,
      maxWidth: AppConfig.maxUploadDimension.toDouble(),
      maxHeight: AppConfig.maxUploadDimension.toDouble(),
      imageQuality: AppConfig.uploadQuality,
    );
    if (picked == null) return;

    final bytes = await picked.readAsBytes();
    final uploads = ref.read(uploadRepositoryProvider);
    final mediaIds = await uploads
        .uploadImages(<Uint8List>[bytes], purpose: 'body_reference');
    await ref.read(tryOnRepositoryProvider).registerBodyPhoto(mediaIds.first);
    ref.invalidate(bodyPhotosProvider);
    if (context.mounted) showMessage(context, 'Photo saved');
  }

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final photos = ref.watch(bodyPhotosProvider);

    return photos.when(
      loading: () => const Center(child: CircularProgressIndicator()),
      error: (error, _) => ErrorView(
        error: error,
        onRetry: () => ref.invalidate(bodyPhotosProvider),
        onGrantConsent: (consent) async {
          await ref.read(accountRepositoryProvider).setConsent(consent, granted: true);
          ref.invalidate(consentsProvider);
        },
      ),
      data: (items) {
        if (items.isEmpty) {
          return EmptyState(
            icon: Icons.person_outline,
            title: 'Add a photo of yourself',
            message: 'Stand facing the camera, full body in frame, plain background. '
                'One good photo is all we need.',
            action: Column(
              children: [
                FilledButton.icon(
                  onPressed: () => _capture(context, ref, ImageSource.camera),
                  icon: const Icon(Icons.camera_alt_outlined),
                  label: const Text('Take a photo'),
                ),
                const SizedBox(height: 10),
                TextButton(
                  onPressed: () => _capture(context, ref, ImageSource.gallery),
                  child: const Text('Choose from library'),
                ),
              ],
            ),
          );
        }
        return _RenderView(photo: items.first);
      },
    );
  }
}

class _RenderView extends ConsumerWidget {
  const _RenderView({required this.photo});

  final BodyPhoto photo;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final state = ref.watch(tryOnControllerProvider);
    final job = state.job;

    return ListView(
      padding: const EdgeInsets.all(AppTheme.gutter),
      children: [
        if (photo.qualityIssues.isNotEmpty)
          Card(
            color: Theme.of(context).colorScheme.errorContainer,
            child: Padding(
              padding: const EdgeInsets.all(12),
              child: Text(
                'This photo may not work well: '
                '${photo.qualityIssues.map((i) => i.replaceAll('_', ' ')).join(', ')}.',
                style: Theme.of(context).textTheme.bodySmall,
              ),
            ),
          ),
        AspectRatio(
          aspectRatio: 3 / 4,
          child: Card(
            clipBehavior: Clip.antiAlias,
            child: _Canvas(state: state, photo: photo),
          ),
        ),
        const SizedBox(height: 14),
        if (job != null && job.isReady) ...[
          if (job.cacheHit)
            Text('Already rendered — shown instantly.',
                style: Theme.of(context).textTheme.bodySmall,),
          if (job.qaFlags.isNotEmpty)
            Text(
              'Heads up: ${job.qaFlags.map((f) => f.replaceAll('_', ' ')).join(', ')}.',
              style: Theme.of(context).textTheme.bodySmall,
            ),
          const SizedBox(height: 8),
          OutlinedButton.icon(
            onPressed: () => ref.read(tryOnControllerProvider.notifier).reset(),
            icon: const Icon(Icons.refresh),
            label: const Text('Try another look'),
          ),
        ],
        if (state.error != null)
          ErrorView(
            error: state.error!,
            onRetry: () => ref.read(tryOnControllerProvider.notifier).reset(),
            onGrantConsent: (consent) async {
              await ref.read(accountRepositoryProvider).setConsent(consent, granted: true);
              ref.invalidate(consentsProvider);
            },
          ),
        const SizedBox(height: 24),
        TextButton.icon(
          onPressed: () async {
            final ok = await confirmDialog(
              context,
              title: 'Delete your photo?',
              message: 'Your photo and every try-on made from it will be deleted.',
            );
            if (!ok) return;
            await ref.read(tryOnRepositoryProvider).deleteBodyPhoto(photo.id);
            ref
              ..invalidate(bodyPhotosProvider)
              ..read(tryOnControllerProvider.notifier).reset();
          },
          icon: const Icon(Icons.delete_outline),
          label: const Text('Delete my photo and renders'),
        ),
      ],
    );
  }
}

class _Canvas extends StatelessWidget {
  const _Canvas({required this.state, required this.photo});

  final TryOnState state;
  final BodyPhoto photo;

  @override
  Widget build(BuildContext context) {
    final job = state.job;

    if (job != null && job.isReady && job.resultUrl != null) {
      return Image.network(job.resultUrl!, fit: BoxFit.contain);
    }
    if (job != null && job.isRunning) {
      return Stack(
        fit: StackFit.expand,
        children: [
          if (photo.url != null)
            Opacity(opacity: 0.35, child: Image.network(photo.url!, fit: BoxFit.contain)),
          Center(
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                CircularProgressIndicator(
                  value: job.totalPasses > 1 ? job.progress : null,
                ),
                const SizedBox(height: 14),
                Text(
                  job.totalPasses > 1
                      ? 'Layer ${job.passIndex} of ${job.totalPasses}'
                      : 'Rendering…',
                ),
                if (job.queuePosition != null && job.queuePosition! > 1)
                  Text('Position ${job.queuePosition} in queue',
                      style: Theme.of(context).textTheme.bodySmall,),
              ],
            ),
          ),
        ],
      );
    }
    if (photo.url != null) {
      return Image.network(photo.url!, fit: BoxFit.contain);
    }
    return const Center(child: Icon(Icons.person_outline, size: 48));
  }
}
