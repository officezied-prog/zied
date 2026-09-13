import 'dart:typed_data';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:image_picker/image_picker.dart';

import '../core/config.dart';
import '../core/theme.dart';
import '../models/models.dart';
import '../providers/providers.dart';
import '../widgets/common.dart';
import 'review_screen.dart';

class WardrobeScreen extends ConsumerStatefulWidget {
  const WardrobeScreen({super.key});

  @override
  ConsumerState<WardrobeScreen> createState() => _WardrobeScreenState();
}

class _WardrobeScreenState extends ConsumerState<WardrobeScreen> {
  final _scroll = ScrollController();

  @override
  void initState() {
    super.initState();
    _scroll.addListener(() {
      // Prefetch a page before the user reaches the bottom.
      if (_scroll.position.pixels > _scroll.position.maxScrollExtent - 600) {
        ref.read(wardrobeProvider.notifier).loadMore();
      }
    });
  }

  @override
  void dispose() {
    _scroll.dispose();
    super.dispose();
  }

  Future<void> _import() async {
    final picker = ImagePicker();
    final picked = await picker.pickMultiImage(
      maxWidth: AppConfig.maxUploadDimension.toDouble(),
      maxHeight: AppConfig.maxUploadDimension.toDouble(),
      imageQuality: AppConfig.uploadQuality,
      limit: AppConfig.uploadBatchSize,
    );
    if (picked.isEmpty || !mounted) return;

    final bytes = <Uint8List>[];
    for (final file in picked) {
      bytes.add(await file.readAsBytes());
    }
    await ref.read(importControllerProvider.notifier).importPhotos(bytes);
  }

  @override
  Widget build(BuildContext context) {
    final wardrobe = ref.watch(wardrobeProvider);
    final filter = ref.watch(wardrobeFilterProvider);
    final review = ref.watch(reviewQueueProvider);
    final progress = ref.watch(importControllerProvider);

    return Scaffold(
      appBar: AppBar(
        title: const Text('Wardrobe'),
        actions: [
          review.maybeWhen(
            data: (items) => items.isEmpty
                ? const SizedBox.shrink()
                : Padding(
                    padding: const EdgeInsets.only(right: 8),
                    child: Badge.count(
                      count: items.length,
                      child: IconButton(
                        tooltip: 'Items to check',
                        icon: const Icon(Icons.fact_check_outlined),
                        onPressed: () => Navigator.of(context).push(
                          MaterialPageRoute<void>(builder: (_) => const ReviewScreen()),
                        ),
                      ),
                    ),
                  ),
            orElse: () => const SizedBox.shrink(),
          ),
        ],
      ),
      floatingActionButton: FloatingActionButton.extended(
        onPressed: progress.isActive ? null : _import,
        icon: const Icon(Icons.add_a_photo_outlined),
        label: const Text('Add photos'),
      ),
      body: Column(
        children: [
          if (progress.isActive || progress.error != null)
            _ImportBanner(progress: progress),
          _FilterBar(filter: filter),
          Expanded(
            child: wardrobe.when(
              loading: () => const Center(child: CircularProgressIndicator()),
              error: (error, _) => ErrorView(
                error: error,
                onRetry: () => ref.read(wardrobeProvider.notifier).refresh(),
              ),
              data: (items) {
                if (items.isEmpty) {
                  return EmptyState(
                    icon: Icons.checkroom_outlined,
                    title: filter.isEmpty ? 'Your wardrobe is empty' : 'Nothing matches',
                    message: filter.isEmpty
                        ? 'Add a few photos and SmartStylist will identify each piece, '
                            'its colours and when it works.'
                        : 'Try clearing a filter.',
                    action: filter.isEmpty
                        ? FilledButton.icon(
                            onPressed: _import,
                            icon: const Icon(Icons.add_a_photo_outlined),
                            label: const Text('Add photos'),
                          )
                        : TextButton(
                            onPressed: () => ref.read(wardrobeFilterProvider.notifier).state =
                                const WardrobeFilter(),
                            child: const Text('Clear filters'),
                          ),
                  );
                }
                return RefreshIndicator(
                  onRefresh: () => ref.read(wardrobeProvider.notifier).refresh(),
                  child: GridView.builder(
                    controller: _scroll,
                    padding: const EdgeInsets.fromLTRB(
                        AppTheme.gutter, 4, AppTheme.gutter, 96,),
                    gridDelegate: const SliverGridDelegateWithMaxCrossAxisExtent(
                      maxCrossAxisExtent: 190,
                      mainAxisSpacing: 12,
                      crossAxisSpacing: 12,
                      childAspectRatio: 0.78,
                    ),
                    itemCount: items.length,
                    itemBuilder: (context, index) => _GarmentTile(garment: items[index]),
                  ),
                );
              },
            ),
          ),
        ],
      ),
    );
  }
}

class _ImportBanner extends ConsumerWidget {
  const _ImportBanner({required this.progress});

  final ImportProgress progress;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    if (progress.error != null) {
      return MaterialBanner(
        content: Text(ErrorView(error: progress.error!).error.toString()),
        actions: [
          TextButton(
            onPressed: () => ref.read(importControllerProvider.notifier).reset(),
            child: const Text('Dismiss'),
          ),
        ],
      );
    }
    final job = progress.job;
    return Padding(
      padding: const EdgeInsets.fromLTRB(AppTheme.gutter, 8, AppTheme.gutter, 4),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            job == null
                ? 'Uploading ${progress.uploading} of ${progress.total}…'
                : 'Identifying items — ${job.itemsProcessed} of ${job.itemsDiscovered} photos',
            style: Theme.of(context).textTheme.bodySmall,
          ),
          const SizedBox(height: 6),
          ClipRRect(
            borderRadius: BorderRadius.circular(999),
            child: LinearProgressIndicator(value: progress.fraction, minHeight: 4),
          ),
        ],
      ),
    );
  }
}

class _FilterBar extends ConsumerWidget {
  const _FilterBar({required this.filter});

  final WardrobeFilter filter;

  static const _roles = [
    ('base_top', 'Tops'),
    ('bottom', 'Bottoms'),
    ('full_body', 'One-piece'),
    ('outerwear', 'Outerwear'),
    ('footwear', 'Shoes'),
    ('bag', 'Bags'),
  ];

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final notifier = ref.read(wardrobeFilterProvider.notifier);
    return SizedBox(
      height: 48,
      child: ListView(
        scrollDirection: Axis.horizontal,
        padding: const EdgeInsets.symmetric(horizontal: AppTheme.gutter),
        children: [
          FilterChip(
            label: const Text('Ready to wear'),
            selected: filter.availableOnly,
            onSelected: (value) =>
                notifier.state = filter.copyWith(availableOnly: value),
          ),
          const SizedBox(width: 8),
          for (final (slug, label) in _roles) ...[
            FilterChip(
              label: Text(label),
              selected: filter.role == slug,
              onSelected: (value) => notifier.state =
                  value ? filter.copyWith(role: slug) : filter.copyWith(clearRole: true),
            ),
            const SizedBox(width: 8),
          ],
        ],
      ),
    );
  }
}

class _GarmentTile extends ConsumerWidget {
  const _GarmentTile({required this.garment});

  final Garment garment;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    return Card(
      clipBehavior: Clip.antiAlias,
      child: InkWell(
        onTap: () => showModalBottomSheet<void>(
          context: context,
          showDragHandle: true,
          builder: (_) => _GarmentSheet(garment: garment),
        ),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Expanded(
              child: Stack(
                fit: StackFit.expand,
                children: [
                  Padding(
                    padding: const EdgeInsets.all(8),
                    child: GarmentImage(garment: garment),
                  ),
                  if (garment.inLaundry)
                    const Positioned(
                      top: 6,
                      left: 6,
                      child: _Pill(icon: Icons.local_laundry_service_outlined,
                          label: 'In wash',),
                    ),
                  if (garment.needsConfirmation)
                    const Positioned(
                      top: 6,
                      right: 6,
                      child: _Pill(icon: Icons.help_outline, label: 'Check'),
                    ),
                ],
              ),
            ),
            Padding(
              padding: const EdgeInsets.fromLTRB(10, 0, 10, 10),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    garment.displayName,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: Theme.of(context).textTheme.titleSmall,
                  ),
                  const SizedBox(height: 4),
                  Row(
                    children: [
                      for (final color in garment.colors.take(3)) ...[
                        ColorDot(family: color.family),
                        const SizedBox(width: 4),
                      ],
                      const Spacer(),
                      Text(
                        garment.wearCount == 0 ? 'unworn' : '${garment.wearCount}×',
                        style: Theme.of(context).textTheme.bodySmall,
                      ),
                    ],
                  ),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class _Pill extends StatelessWidget {
  const _Pill({required this.icon, required this.label});

  final IconData icon;
  final String label;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
      decoration: BoxDecoration(
        color: Theme.of(context).colorScheme.surface.withValues(alpha: 0.9),
        borderRadius: BorderRadius.circular(999),
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          Icon(icon, size: 12),
          const SizedBox(width: 4),
          Text(label, style: Theme.of(context).textTheme.labelSmall),
        ],
      ),
    );
  }
}

class _GarmentSheet extends ConsumerWidget {
  const _GarmentSheet({required this.garment});

  final Garment garment;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final notifier = ref.read(wardrobeProvider.notifier);
    return SafeArea(
      child: Padding(
        padding: const EdgeInsets.fromLTRB(AppTheme.gutter, 0, AppTheme.gutter, AppTheme.gutter),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            SizedBox(height: 180, child: GarmentImage(garment: garment)),
            const SizedBox(height: 12),
            Text(garment.displayName, style: Theme.of(context).textTheme.headlineSmall),
            const SizedBox(height: 4),
            Text(
              [
                if (garment.brand != null) garment.brand!,
                Labels.role(garment.role),
                Labels.formality(garment.formality),
                if (garment.material.isNotEmpty) garment.material.join(', '),
              ].join(' · '),
              style: Theme.of(context).textTheme.bodyMedium,
            ),
            if (garment.needsConfirmation) ...[
              const SizedBox(height: 10),
              Text(
                'Identified automatically'
                '${garment.tagConfidence == null ? '' : ' (${(garment.tagConfidence! * 100).round()}% sure)'}'
                ' — tap edit if anything is wrong.',
                style: Theme.of(context).textTheme.bodySmall,
              ),
            ],
            const SizedBox(height: 16),
            Row(
              children: [
                Expanded(
                  child: OutlinedButton.icon(
                    onPressed: () async {
                      Navigator.of(context).pop();
                      await notifier.toggleLaundry(garment);
                    },
                    icon: const Icon(Icons.local_laundry_service_outlined),
                    label: Text(garment.inLaundry ? 'Back from wash' : 'In the wash'),
                  ),
                ),
                const SizedBox(width: 10),
                Expanded(
                  child: OutlinedButton.icon(
                    onPressed: () async {
                      await ref.read(wardrobeRepositoryProvider).logWear(garment.id);
                      if (context.mounted) {
                        Navigator.of(context).pop();
                        showMessage(context, 'Logged as worn today');
                      }
                    },
                    icon: const Icon(Icons.check),
                    label: const Text('Wore it'),
                  ),
                ),
              ],
            ),
            const SizedBox(height: 8),
            TextButton.icon(
              onPressed: () async {
                final ok = await confirmDialog(
                  context,
                  title: 'Remove this item?',
                  message: 'It will no longer appear in suggestions.',
                );
                if (ok && context.mounted) {
                  Navigator.of(context).pop();
                  await notifier.remove(garment);
                }
              },
              icon: const Icon(Icons.delete_outline),
              label: const Text('Remove from wardrobe'),
            ),
          ],
        ),
      ),
    );
  }
}
