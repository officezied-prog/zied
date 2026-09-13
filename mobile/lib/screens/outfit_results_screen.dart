import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../core/theme.dart';
import '../models/models.dart';
import '../providers/providers.dart';
import '../widgets/common.dart';
import 'outfit_detail_screen.dart';

class OutfitResultsScreen extends ConsumerWidget {
  const OutfitResultsScreen({super.key, required this.occasion});

  final String occasion;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final state = ref.watch(recommendationProvider);

    return Scaffold(
      appBar: AppBar(
        title: Text(Labels.role(occasion)),
        actions: [
          IconButton(
            tooltip: 'Suggest again',
            icon: const Icon(Icons.refresh),
            onPressed: () =>
                ref.read(recommendationProvider.notifier).run(occasion: occasion),
          ),
        ],
      ),
      body: state.when(
        loading: () => const _Thinking(),
        error: (error, _) => ErrorView(
          error: error,
          onRetry: () => ref.read(recommendationProvider.notifier).run(occasion: occasion),
        ),
        data: (recommendation) {
          if (recommendation == null) {
            return const EmptyState(
              icon: Icons.auto_awesome_outlined,
              title: 'Nothing yet',
              message: 'Pick an occasion to see suggestions.',
            );
          }
          if (recommendation.outfits.isEmpty) {
            return const EmptyState(
              icon: Icons.checkroom_outlined,
              title: 'Not enough to work with',
              message: 'Add a few more pieces and try again.',
            );
          }
          return ListView(
            padding: const EdgeInsets.fromLTRB(
                AppTheme.gutter, 4, AppTheme.gutter, AppTheme.gutter,),
            children: [
              Row(
                children: [
                  if (recommendation.weather != null)
                    WeatherPill(weather: recommendation.weather!),
                  const Spacer(),
                  Text(
                    '${recommendation.candidateCount} pieces considered',
                    style: Theme.of(context).textTheme.bodySmall,
                  ),
                ],
              ),
              const SizedBox(height: 12),
              for (final outfit in recommendation.outfits) ...[
                _OutfitCard(outfit: outfit),
                const SizedBox(height: 14),
              ],
            ],
          );
        },
      ),
    );
  }
}

class _Thinking extends StatelessWidget {
  const _Thinking();

  @override
  Widget build(BuildContext context) {
    return const Center(
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          CircularProgressIndicator(),
          SizedBox(height: 16),
          Text('Checking the weather and your wardrobe…'),
        ],
      ),
    );
  }
}

class _OutfitCard extends ConsumerWidget {
  const _OutfitCard({required this.outfit});

  final Outfit outfit;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    return Card(
      clipBehavior: Clip.antiAlias,
      child: InkWell(
        onTap: () => Navigator.of(context).push(
          MaterialPageRoute<void>(
            builder: (_) => OutfitDetailScreen(outfitId: outfit.id),
          ),
        ),
        child: Padding(
          padding: const EdgeInsets.all(14),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              SizedBox(
                height: 130,
                child: Row(
                  children: [
                    for (final item in outfit.orderedItems.take(5))
                      Expanded(
                        child: Padding(
                          padding: const EdgeInsets.symmetric(horizontal: 3),
                          child: GarmentImage(garment: item.garment),
                        ),
                      ),
                  ],
                ),
              ),
              const SizedBox(height: 12),
              if (outfit.rationale != null)
                Text(outfit.rationale!, style: Theme.of(context).textTheme.bodyMedium),
              const SizedBox(height: 10),
              Row(
                children: [
                  for (final reason in outfit.topReasons) ...[
                    Chip(
                      visualDensity: VisualDensity.compact,
                      label: Text(
                        Labels.scoreTerm(reason.key),
                        style: Theme.of(context).textTheme.labelSmall,
                      ),
                    ),
                    const SizedBox(width: 6),
                  ],
                  const Spacer(),
                  _FeedbackButtons(outfit: outfit),
                ],
              ),
            ],
          ),
        ),
      ),
    );
  }
}

class _FeedbackButtons extends ConsumerStatefulWidget {
  const _FeedbackButtons({required this.outfit});

  final Outfit outfit;

  @override
  ConsumerState<_FeedbackButtons> createState() => _FeedbackButtonsState();
}

class _FeedbackButtonsState extends ConsumerState<_FeedbackButtons> {
  String? _sent;

  Future<void> _send(String kind) async {
    setState(() => _sent = kind);
    await ref.read(recommendationProvider.notifier).feedback(widget.outfit.id, kind);
    if (mounted) {
      showMessage(context,
          kind == 'like' ? 'Noted — more like this' : 'Noted — fewer like this',);
    }
  }

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return Row(
      children: [
        IconButton(
          visualDensity: VisualDensity.compact,
          onPressed: _sent != null ? null : () => _send('dislike'),
          icon: Icon(
            Icons.thumb_down_outlined,
            size: 20,
            color: _sent == 'dislike' ? scheme.error : null,
          ),
        ),
        IconButton(
          visualDensity: VisualDensity.compact,
          onPressed: _sent != null ? null : () => _send('like'),
          icon: Icon(
            _sent == 'like' ? Icons.favorite : Icons.favorite_outline,
            size: 20,
            color: _sent == 'like' ? scheme.primary : null,
          ),
        ),
      ],
    );
  }
}
