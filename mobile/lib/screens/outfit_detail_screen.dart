import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../core/theme.dart';
import '../models/models.dart';
import '../providers/providers.dart';
import '../widgets/common.dart';
import 'tryon_screen.dart';

class OutfitDetailScreen extends ConsumerWidget {
  const OutfitDetailScreen({super.key, required this.outfitId});

  final String outfitId;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final outfit = ref.watch(outfitProvider(outfitId));

    return Scaffold(
      appBar: AppBar(
        title: const Text('The look'),
        actions: [
          outfit.maybeWhen(
            data: (value) => IconButton(
              icon: Icon(value.isFavorite ? Icons.bookmark : Icons.bookmark_border),
              onPressed: () async {
                await ref
                    .read(stylingRepositoryProvider)
                    .setFavorite(outfitId, value: !value.isFavorite);
                ref.invalidate(outfitProvider(outfitId));
                ref.invalidate(savedOutfitsProvider);
              },
            ),
            orElse: () => const SizedBox.shrink(),
          ),
        ],
      ),
      body: outfit.when(
        loading: () => const Center(child: CircularProgressIndicator()),
        error: (error, _) => ErrorView(
          error: error,
          onRetry: () => ref.invalidate(outfitProvider(outfitId)),
        ),
        data: (value) => ListView(
          padding: const EdgeInsets.fromLTRB(AppTheme.gutter, 8, AppTheme.gutter, 120),
          children: [
            if (value.rationale != null)
              Card(
                child: Padding(
                  padding: const EdgeInsets.all(14),
                  child: Text(
                    value.rationale!,
                    style: Theme.of(context).textTheme.bodyLarge,
                  ),
                ),
              ),
            const SizedBox(height: 16),
            Text('Pieces', style: Theme.of(context).textTheme.titleMedium),
            const SizedBox(height: 8),
            for (final item in value.orderedItems)
              _ItemRow(outfitId: outfitId, item: item),
            const SizedBox(height: 20),
            Text('Why this works', style: Theme.of(context).textTheme.titleMedium),
            const SizedBox(height: 6),
            for (final entry in value.scoreBreakdown.entries)
              if (entry.key != 'completeness')
                ScoreBar(label: Labels.scoreTerm(entry.key), value: entry.value),
          ],
        ),
      ),
      bottomNavigationBar: SafeArea(
        child: Padding(
          padding: const EdgeInsets.all(AppTheme.gutter),
          child: FilledButton.icon(
            onPressed: () {
              ref.read(tryOnControllerProvider.notifier).render(outfitId: outfitId);
              Navigator.of(context).push(
                MaterialPageRoute<void>(builder: (_) => const TryOnScreen()),
              );
            },
            icon: const Icon(Icons.person_outline),
            label: const Text('See it on me'),
          ),
        ),
      ),
    );
  }
}

class _ItemRow extends ConsumerWidget {
  const _ItemRow({required this.outfitId, required this.item});

  final String outfitId;
  final OutfitItem item;

  Future<void> _swap(BuildContext context, WidgetRef ref) async {
    final options = await ref
        .read(stylingRepositoryProvider)
        .alternatives(outfitId, item.role, exclude: [item.garment.id]);
    if (!context.mounted) return;

    if (options.isEmpty) {
      showMessage(context, 'Nothing else in your wardrobe fits that slot.');
      return;
    }

    await showModalBottomSheet<void>(
      context: context,
      showDragHandle: true,
      builder: (context) => SafeArea(
        child: ListView(
          shrinkWrap: true,
          padding: const EdgeInsets.all(AppTheme.gutter),
          children: [
            Text('Swap ${Labels.role(item.role).toLowerCase()}',
                style: Theme.of(context).textTheme.titleMedium,),
            const SizedBox(height: 8),
            for (final option in options)
              ListTile(
                leading: SizedBox(
                  width: 44,
                  height: 44,
                  child: GarmentImage(garment: option.garment),
                ),
                title: Text(option.garment.displayName),
                subtitle: Text('Scores ${(option.score * 100).round()} in this look'),
                onTap: () => Navigator.of(context).pop(),
              ),
          ],
        ),
      ),
    );
  }

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    return Padding(
      padding: const EdgeInsets.only(bottom: 8),
      child: Card(
        child: ListTile(
          leading: SizedBox(width: 48, height: 48, child: GarmentImage(garment: item.garment)),
          title: Text(item.garment.displayName),
          subtitle: Row(
            children: [
              Text(Labels.role(item.role)),
              if (item.garment.primaryColor != null) ...[
                const SizedBox(width: 8),
                ColorDot(family: item.garment.primaryColor!.family, size: 10),
              ],
            ],
          ),
          trailing: IconButton(
            tooltip: 'Swap this piece',
            icon: const Icon(Icons.swap_horiz),
            onPressed: () => _swap(context, ref),
          ),
        ),
      ),
    );
  }
}
