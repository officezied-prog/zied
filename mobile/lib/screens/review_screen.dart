import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../core/theme.dart';
import '../models/models.dart';
import '../providers/providers.dart';
import '../widgets/common.dart';

/// The review queue: items the vision pipeline was not confident about.
///
/// One decision per card, two taps maximum. Every accept or reject is also a
/// training label, which is why the flow is this cheap.
class ReviewScreen extends ConsumerWidget {
  const ReviewScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final queue = ref.watch(reviewQueueProvider);

    return Scaffold(
      appBar: AppBar(title: const Text('Quick check')),
      body: queue.when(
        loading: () => const Center(child: CircularProgressIndicator()),
        error: (error, _) => ErrorView(
          error: error,
          onRetry: () => ref.invalidate(reviewQueueProvider),
        ),
        data: (items) {
          if (items.isEmpty) {
            return const EmptyState(
              icon: Icons.done_all,
              title: 'All caught up',
              message: 'Everything we found has been sorted into your wardrobe.',
            );
          }
          return ListView.separated(
            padding: const EdgeInsets.all(AppTheme.gutter),
            itemCount: items.length,
            separatorBuilder: (_, __) => const SizedBox(height: 12),
            itemBuilder: (context, index) => _ReviewCard(card: items[index]),
          );
        },
      ),
    );
  }
}

class _ReviewCard extends ConsumerWidget {
  const _ReviewCard({required this.card});

  final DetectionCard card;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final repo = ref.read(wardrobeRepositoryProvider);

    return Card(
      child: Padding(
        padding: const EdgeInsets.all(12),
        child: Row(
          children: [
            SizedBox(
              width: 84,
              height: 84,
              child: card.cutoutUrl == null
                  ? const Icon(Icons.image_outlined)
                  : Image.network(card.cutoutUrl!, fit: BoxFit.contain),
            ),
            const SizedBox(width: 14),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    card.suggestedCategory ?? card.label,
                    style: Theme.of(context).textTheme.titleMedium,
                  ),
                  const SizedBox(height: 2),
                  Text(card.reason, style: Theme.of(context).textTheme.bodySmall),
                  const SizedBox(height: 10),
                  Row(
                    children: [
                      FilledButton(
                        style: FilledButton.styleFrom(
                          minimumSize: const Size(96, 38),
                          padding: const EdgeInsets.symmetric(horizontal: 12),
                        ),
                        onPressed: card.suggestedCategoryId == null
                            ? null
                            : () async {
                                await repo.acceptDetection(card.id);
                                ref.invalidate(reviewQueueProvider);
                                ref.invalidate(wardrobeProvider);
                              },
                        child: const Text('Keep'),
                      ),
                      const SizedBox(width: 10),
                      OutlinedButton(
                        style: OutlinedButton.styleFrom(
                          minimumSize: const Size(96, 38),
                          padding: const EdgeInsets.symmetric(horizontal: 12),
                        ),
                        onPressed: () async {
                          await repo.rejectDetection(card.id);
                          ref.invalidate(reviewQueueProvider);
                        },
                        child: const Text('Not mine'),
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
