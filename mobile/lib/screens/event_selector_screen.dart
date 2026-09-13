import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../core/theme.dart';
import '../models/models.dart';
import '../providers/providers.dart';
import '../widgets/common.dart';
import 'outfit_results_screen.dart';

/// "Where are you going?" — the one question the whole engine is built around.
class EventSelectorScreen extends ConsumerWidget {
  const EventSelectorScreen({super.key});

  static const _icons = <String, IconData>{
    'date_night': Icons.favorite_outline,
    'business_meeting': Icons.work_outline,
    'job_interview': Icons.badge_outlined,
    'casual_gathering': Icons.people_outline,
    'formal_event': Icons.star_outline,
    'wedding_guest': Icons.celebration_outlined,
    'night_out': Icons.nightlife_outlined,
    'brunch': Icons.local_cafe_outlined,
    'workout': Icons.fitness_center_outlined,
    'travel_day': Icons.flight_outlined,
    'beach_day': Icons.beach_access_outlined,
    'religious_service': Icons.account_balance_outlined,
    'funeral': Icons.cloud_outlined,
    'conference': Icons.co_present_outlined,
    'home_lounge': Icons.home_outlined,
  };

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final occasions = ref.watch(occasionsProvider);
    final selected = ref.watch(selectedOccasionProvider);

    return Scaffold(
      appBar: AppBar(title: const Text('What is the occasion?')),
      body: occasions.when(
        loading: () => const Center(child: CircularProgressIndicator()),
        error: (error, _) =>
            ErrorView(error: error, onRetry: () => ref.invalidate(occasionsProvider)),
        data: (items) => Column(
          children: [
            Expanded(
              child: GridView.builder(
                padding: const EdgeInsets.all(AppTheme.gutter),
                gridDelegate: const SliverGridDelegateWithMaxCrossAxisExtent(
                  maxCrossAxisExtent: 190,
                  mainAxisSpacing: 12,
                  crossAxisSpacing: 12,
                  childAspectRatio: 1.35,
                ),
                itemCount: items.length,
                itemBuilder: (context, index) {
                  final occasion = items[index];
                  final isSelected = occasion.slug == selected;
                  return _OccasionCard(
                    occasion: occasion,
                    icon: _icons[occasion.slug] ?? Icons.auto_awesome_outlined,
                    selected: isSelected,
                    onTap: () => ref.read(selectedOccasionProvider.notifier).state =
                        occasion.slug,
                  );
                },
              ),
            ),
            SafeArea(
              child: Padding(
                padding: const EdgeInsets.fromLTRB(
                    AppTheme.gutter, 0, AppTheme.gutter, AppTheme.gutter,),
                child: FilledButton.icon(
                  onPressed: selected == null
                      ? null
                      : () {
                          ref.read(recommendationProvider.notifier).run(occasion: selected);
                          Navigator.of(context).push(
                            MaterialPageRoute<void>(
                              builder: (_) => OutfitResultsScreen(occasion: selected),
                            ),
                          );
                        },
                  icon: const Icon(Icons.auto_awesome),
                  label: const Text('Style me'),
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class _OccasionCard extends StatelessWidget {
  const _OccasionCard({
    required this.occasion,
    required this.icon,
    required this.selected,
    required this.onTap,
  });

  final Occasion occasion;
  final IconData icon;
  final bool selected;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return Card(
      color: selected ? scheme.primaryContainer : null,
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(AppTheme.radius),
        side: BorderSide(
          color: selected ? scheme.primary : scheme.outlineVariant,
          width: selected ? 2 : 1,
        ),
      ),
      child: InkWell(
        borderRadius: BorderRadius.circular(AppTheme.radius),
        onTap: onTap,
        child: Padding(
          padding: const EdgeInsets.all(14),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            mainAxisAlignment: MainAxisAlignment.spaceBetween,
            children: [
              Icon(icon, color: selected ? scheme.onPrimaryContainer : scheme.primary),
              Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    occasion.displayName,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: Theme.of(context).textTheme.titleSmall,
                  ),
                  Text(
                    Labels.formality(occasion.formalityMax),
                    style: Theme.of(context).textTheme.bodySmall,
                  ),
                ],
              ),
            ],
          ),
        ),
      ),
    );
  }
}
