import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../core/config.dart';
import '../core/theme.dart';
import '../data/demo_shop.dart';
import '../models/models.dart';
import '../providers/providers.dart';
import '../widgets/common.dart';

/// Shop mode: point the app at something on a rail before buying it.
///
/// The answer is arithmetic over clothes already at home — how many it
/// duplicates, what it would newly go with, and what to look for instead when
/// the honest answer is "you have this already".
class ShopScreen extends ConsumerWidget {
  const ShopScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final state = ref.watch(shopControllerProvider);

    return Scaffold(
      appBar: AppBar(
        title: const Text('In a shop'),
        actions: [
          if (state.result != null)
            TextButton(
              onPressed: () => ref.read(shopControllerProvider.notifier).reset(),
              child: const Text('New scan'),
            ),
        ],
      ),
      body: ListView(
        padding: const EdgeInsets.fromLTRB(
            AppTheme.gutter, AppTheme.gutter, AppTheme.gutter, 32,),
        children: [
          const _Intro(),
          const SizedBox(height: 16),
          const _Rail(),
          const SizedBox(height: 24),
          if (state.scanning) const _Scanning(),
          if (state.error != null)
            ErrorView(
              error: state.error!,
              onRetry: () => ref.read(shopControllerProvider.notifier).reset(),
            ),
          if (state.filed != null) _Filed(category: state.filed!),
          if (state.result != null) _Verdict(scan: state.result!),
          if (state.result == null &&
              state.filed == null &&
              !state.scanning &&
              state.error == null)
            const _Waiting(),
        ],
      ),
    );
  }
}

class _Intro extends StatelessWidget {
  const _Intro();

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return Row(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Icon(Icons.photo_camera_outlined, size: 18, color: scheme.outline),
        const SizedBox(width: 10),
        Expanded(
          child: Text(
            AppConfig.demoMode
                ? 'The camera needs a phone, so the demo hands you a rail '
                    'instead. Pick something up and the app checks it against '
                    'the wardrobe at home.'
                : 'Photograph something on the rail and the app checks it '
                    'against the wardrobe at home before you buy it.',
            style: Theme.of(context)
                .textTheme
                .bodySmall
                ?.copyWith(color: scheme.onSurfaceVariant, height: 1.5),
          ),
        ),
      ],
    );
  }
}

/// The things on offer. In a real build this row is the camera button.
class _Rail extends ConsumerWidget {
  const _Rail();

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final state = ref.watch(shopControllerProvider);
    return SizedBox(
      height: 132,
      child: ListView.separated(
        scrollDirection: Axis.horizontal,
        itemCount: demoRack.length,
        separatorBuilder: (_, __) => const SizedBox(width: 10),
        itemBuilder: (context, index) {
          final item = demoRack[index];
          final selected = state.result?.primaryHex == item.hex &&
              state.result?.category == item.category;
          return _RackCard(
            item: item,
            selected: selected,
            onTap: state.scanning
                ? null
                : () => ref.read(shopControllerProvider.notifier).scan(item.id),
          );
        },
      ),
    );
  }
}

class _RackCard extends StatelessWidget {
  const _RackCard({required this.item, required this.selected, this.onTap});

  final RackItem item;
  final bool selected;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return InkWell(
      onTap: onTap,
      borderRadius: BorderRadius.circular(AppTheme.radius),
      child: Container(
        width: 108,
        padding: const EdgeInsets.all(8),
        decoration: BoxDecoration(
          borderRadius: BorderRadius.circular(AppTheme.radius),
          border: Border.all(
            color: selected ? scheme.primary : scheme.outlineVariant,
            width: selected ? 2 : 1,
          ),
        ),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Expanded(
              child: Container(
                width: double.infinity,
                decoration: BoxDecoration(
                  color: Color(item.argb),
                  borderRadius: BorderRadius.circular(10),
                  border: Border.all(color: scheme.outlineVariant),
                ),
              ),
            ),
            const SizedBox(height: 6),
            Text(
              item.name,
              maxLines: 2,
              overflow: TextOverflow.ellipsis,
              style: Theme.of(context).textTheme.labelSmall?.copyWith(height: 1.3),
            ),
          ],
        ),
      ),
    );
  }
}

/// Before the first pick. Says what the answer will be made of, so the wait
/// is not a blank screen.
class _Waiting extends StatelessWidget {
  const _Waiting();

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return Padding(
      padding: const EdgeInsets.only(top: 40),
      child: Column(
        children: [
          Icon(Icons.checkroom_outlined, size: 36, color: scheme.outlineVariant),
          const SizedBox(height: 14),
          Text('Pick something off the rail',
              style: Theme.of(context).textTheme.titleSmall,),
          const SizedBox(height: 8),
          Padding(
            padding: const EdgeInsets.symmetric(horizontal: 24),
            child: Text(
              'You will get back how many pieces at home it duplicates, what '
              'it would newly go with, and — when the answer is no — the '
              'colours and shapes worth looking for instead.',
              textAlign: TextAlign.center,
              style: Theme.of(context)
                  .textTheme
                  .bodySmall
                  ?.copyWith(color: scheme.onSurfaceVariant, height: 1.5),
            ),
          ),
        ],
      ),
    );
  }
}

class _Scanning extends StatelessWidget {
  const _Scanning();

  @override
  Widget build(BuildContext context) {
    return Column(
      children: [
        const LinearProgressIndicator(),
        const SizedBox(height: 12),
        Text('Checking it against your wardrobe…',
            style: Theme.of(context).textTheme.bodySmall,),
      ],
    );
  }
}

class _Filed extends StatelessWidget {
  const _Filed({required this.category});

  final String category;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return Card(
      color: scheme.secondaryContainer,
      child: ListTile(
        leading: Icon(Icons.check_circle_outline, color: scheme.onSecondaryContainer),
        title: Text('Added to your wardrobe',
            style: TextStyle(color: scheme.onSecondaryContainer),),
        subtitle: Text('The next scan counts your new $category as owned.',
            style: TextStyle(color: scheme.onSecondaryContainer),),
      ),
    );
  }
}

/// The answer, in the order a person needs it: verdict, why, what to do.
class _Verdict extends ConsumerWidget {
  const _Verdict({required this.scan});

  final ScanResult scan;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final scheme = Theme.of(context).colorScheme;
    final controller = ref.read(shopControllerProvider.notifier);

    return Card(
      child: Padding(
        padding: const EdgeInsets.all(AppTheme.gutter),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Container(
                  width: 44,
                  height: 44,
                  decoration: BoxDecoration(
                    color: Color(scan.argb),
                    borderRadius: BorderRadius.circular(10),
                    border: Border.all(color: scheme.outlineVariant),
                  ),
                ),
                const SizedBox(width: 12),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(scan.headline,
                          style: Theme.of(context).textTheme.titleMedium,),
                      const SizedBox(height: 2),
                      Text(
                        '${scan.colorFamily.replaceAll('_', ' ')} '
                        '${scan.displayCategory}',
                        style: Theme.of(context)
                            .textTheme
                            .bodySmall
                            ?.copyWith(color: scheme.onSurfaceVariant),
                      ),
                    ],
                  ),
                ),
                _VerdictChip(verdict: scan.verdict),
              ],
            ),
            const SizedBox(height: 12),
            Text(scan.detail,
                style: Theme.of(context).textTheme.bodyMedium?.copyWith(height: 1.5),),

            if (scan.wearWith.isNotEmpty) ...[
              const SizedBox(height: 18),
              const _SectionLabel('Wear it with'),
              const SizedBox(height: 8),
              _WearWithRow(scan: scan),
            ],

            if (scan.duplicates.isNotEmpty) ...[
              const SizedBox(height: 18),
              const _SectionLabel('Already at home'),
              const SizedBox(height: 8),
              for (final owned in scan.duplicates)
                _OwnedRow(owned: owned),
            ],

            if (scan.unlockedOccasions.isNotEmpty) ...[
              const SizedBox(height: 18),
              const _SectionLabel('Would let you dress'),
              const SizedBox(height: 8),
              Wrap(
                spacing: 6,
                runSpacing: 6,
                children: [
                  for (final occasion in scan.unlockedOccasions.take(6))
                    Chip(
                      label: Text(occasion),
                      visualDensity: VisualDensity.compact,
                      materialTapTargetSize: MaterialTapTargetSize.shrinkWrap,
                    ),
                ],
              ),
            ],

            if (scan.lookForColors.isNotEmpty || scan.lookForRoles.isNotEmpty) ...[
              const SizedBox(height: 18),
              const _SectionLabel('Look for this instead'),
              const SizedBox(height: 8),
              Wrap(
                spacing: 6,
                runSpacing: 6,
                children: [
                  for (final colour in scan.lookForColors)
                    Chip(
                      avatar: ColorDot(family: colour.family),
                      label: Text(colour.family.replaceAll('_', ' ')),
                      visualDensity: VisualDensity.compact,
                      materialTapTargetSize: MaterialTapTargetSize.shrinkWrap,
                    ),
                  for (final role in scan.lookForRoles)
                    Chip(
                      label: Text(rolePhrase[role] ?? role.replaceAll('_', ' ')),
                      visualDensity: VisualDensity.compact,
                      materialTapTargetSize: MaterialTapTargetSize.shrinkWrap,
                    ),
                ],
              ),
            ],

            const SizedBox(height: 18),
            _Counts(scan: scan),
            const SizedBox(height: 12),
            Row(
              children: [
                Expanded(
                  child: OutlinedButton(
                    onPressed: controller.dismiss,
                    child: const Text('Left it'),
                  ),
                ),
                const SizedBox(width: 10),
                Expanded(
                  child: FilledButton(
                    onPressed: controller.bought,
                    child: const Text('I bought it'),
                  ),
                ),
              ],
            ),
          ],
        ),
      ),
    );
  }
}

class _VerdictChip extends StatelessWidget {
  const _VerdictChip({required this.verdict});

  final ScanVerdict verdict;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    final (label, background, foreground) = switch (verdict) {
      ScanVerdict.fillsAGap => ('Gap', scheme.primaryContainer, scheme.onPrimaryContainer),
      ScanVerdict.addsVariety =>
        ('Good buy', scheme.secondaryContainer, scheme.onSecondaryContainer),
      ScanVerdict.haveSimilar =>
        ('Have it', scheme.surfaceContainerHighest, scheme.onSurfaceVariant),
      ScanVerdict.hardToWear =>
        ('Risky', scheme.errorContainer, scheme.onErrorContainer),
    };
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 5),
      decoration: BoxDecoration(
        color: background,
        borderRadius: BorderRadius.circular(999),
      ),
      child: Text(label,
          style: Theme.of(context)
              .textTheme
              .labelSmall
              ?.copyWith(color: foreground, fontWeight: FontWeight.w600),),
    );
  }
}

/// The outfit it would join — the scanned piece first, then what it goes with.
class _WearWithRow extends StatelessWidget {
  const _WearWithRow({required this.scan});

  final ScanResult scan;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return Row(
      children: [
        _Swatch(argb: scan.argb, label: 'this', emphasised: true),
        Padding(
          padding: const EdgeInsets.symmetric(horizontal: 6),
          child: Icon(Icons.add, size: 14, color: scheme.outline),
        ),
        for (var i = 0; i < scan.wearWith.length; i++) ...[
          if (i > 0)
            Padding(
              padding: const EdgeInsets.symmetric(horizontal: 6),
              child: Icon(Icons.add, size: 14, color: scheme.outline),
            ),
          Flexible(
            child: _Swatch(
              argb: scan.wearWith[i].argb,
              label: scan.wearWith[i].name,
            ),
          ),
        ],
      ],
    );
  }
}

class _Swatch extends StatelessWidget {
  const _Swatch({required this.argb, required this.label, this.emphasised = false});

  final int argb;
  final String label;
  final bool emphasised;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return Column(
      mainAxisSize: MainAxisSize.min,
      children: [
        Container(
          width: 40,
          height: 40,
          decoration: BoxDecoration(
            color: Color(argb),
            borderRadius: BorderRadius.circular(8),
            border: Border.all(
              color: emphasised ? scheme.primary : scheme.outlineVariant,
              width: emphasised ? 2 : 1,
            ),
          ),
        ),
        const SizedBox(height: 4),
        SizedBox(
          width: 62,
          child: Text(
            label,
            maxLines: 2,
            textAlign: TextAlign.center,
            overflow: TextOverflow.ellipsis,
            style: Theme.of(context)
                .textTheme
                .labelSmall
                ?.copyWith(color: scheme.onSurfaceVariant, height: 1.2),
          ),
        ),
      ],
    );
  }
}

class _OwnedRow extends StatelessWidget {
  const _OwnedRow({required this.owned});

  final OwnedMatch owned;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return Padding(
      padding: const EdgeInsets.only(bottom: 6),
      child: Row(
        children: [
          Container(
            width: 16,
            height: 16,
            decoration: BoxDecoration(
              color: Color(owned.argb),
              borderRadius: BorderRadius.circular(4),
              border: Border.all(color: scheme.outlineVariant),
            ),
          ),
          const SizedBox(width: 8),
          Expanded(
            child: Text(owned.name,
                style: Theme.of(context).textTheme.bodySmall,),
          ),
          Text('ΔE ${owned.deltaE.toStringAsFixed(1)}',
              style: Theme.of(context)
                  .textTheme
                  .labelSmall
                  ?.copyWith(color: scheme.onSurfaceVariant),),
        ],
      ),
    );
  }
}

/// The numbers the verdict rests on, shown so it can be argued with.
class _Counts extends StatelessWidget {
  const _Counts({required this.scan});

  final ScanResult scan;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
      decoration: BoxDecoration(
        color: scheme.surfaceContainerHighest,
        borderRadius: BorderRadius.circular(10),
      ),
      child: Row(
        mainAxisAlignment: MainAxisAlignment.spaceBetween,
        children: [
          _Count(label: 'goes with', value: '${scan.newPairings}'),
          _Count(label: 'of', value: '${scan.totalComplements}'),
          _Count(label: 'duplicates', value: '${scan.duplicates.length}'),
          _Count(label: 'unlocks', value: '${scan.unlockedOccasions.length}'),
        ],
      ),
    );
  }
}

class _Count extends StatelessWidget {
  const _Count({required this.label, required this.value});

  final String label;
  final String value;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return Column(
      children: [
        Text(value, style: Theme.of(context).textTheme.titleMedium),
        Text(label,
            style: Theme.of(context)
                .textTheme
                .labelSmall
                ?.copyWith(color: scheme.onSurfaceVariant),),
      ],
    );
  }
}

class _SectionLabel extends StatelessWidget {
  const _SectionLabel(this.text);

  final String text;

  @override
  Widget build(BuildContext context) {
    return Text(
      text.toUpperCase(),
      style: Theme.of(context).textTheme.labelSmall?.copyWith(
            letterSpacing: 0.8,
            fontWeight: FontWeight.w600,
            color: Theme.of(context).colorScheme.onSurfaceVariant,
          ),
    );
  }
}
