import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../core/theme.dart';
import '../providers/providers.dart';
import '../widgets/common.dart';

class ProfileScreen extends ConsumerWidget {
  const ProfileScreen({super.key});

  static const _consentLabels = <String, (String, String)>{
    'biometric_processing': (
      'Body measurements',
      'Lets us size and flatter suggestions to your shape.'
    ),
    'vton_processing': (
      'Virtual try-on',
      'Lets us show clothes on your own photo.'
    ),
    'social_ingest': (
      'Import from social accounts',
      'Reads only your own posts, and only while connected.'
    ),
    'model_training': (
      'Help improve SmartStylist',
      'Your corrections improve the model. Never your photos of you.'
    ),
  };

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final stats = ref.watch(wardrobeStatsProvider);
    final consents = ref.watch(consentsProvider);

    return Scaffold(
      appBar: AppBar(title: const Text('Profile')),
      body: ListView(
        padding: const EdgeInsets.all(AppTheme.gutter),
        children: [
          stats.when(
            loading: () => const Card(
              child: Padding(
                padding: EdgeInsets.all(20),
                child: Center(child: CircularProgressIndicator()),
              ),
            ),
            error: (error, _) => ErrorView(
              error: error,
              onRetry: () => ref.invalidate(wardrobeStatsProvider),
            ),
            data: (value) => Card(
              child: Padding(
                padding: const EdgeInsets.all(16),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text('Your wardrobe',
                        style: Theme.of(context).textTheme.titleMedium,),
                    const SizedBox(height: 12),
                    Row(
                      children: [
                        _Stat(label: 'Pieces', value: '${value.items}'),
                        _Stat(label: 'Never worn', value: '${value.neverWorn}'),
                        _Stat(label: 'Worn (30d)', value: '${value.wornLast30d}'),
                      ],
                    ),
                    if (value.gaps.isNotEmpty) ...[
                      const SizedBox(height: 12),
                      Text(
                        'Missing before we can style you: '
                        '${value.gaps.map((g) => g.replaceAll('no_', '').replaceAll('_', ' ')).join(', ')}.',
                        style: Theme.of(context).textTheme.bodySmall,
                      ),
                    ],
                  ],
                ),
              ),
            ),
          ),
          const SizedBox(height: 20),
          Text('Permissions', style: Theme.of(context).textTheme.titleMedium),
          const SizedBox(height: 4),
          Text(
            'Each one is separate, and each can be withdrawn at any time.',
            style: Theme.of(context).textTheme.bodySmall,
          ),
          const SizedBox(height: 8),
          consents.when(
            loading: () => const LinearProgressIndicator(),
            error: (error, _) => ErrorView(
              error: error,
              onRetry: () => ref.invalidate(consentsProvider),
            ),
            data: (map) => Card(
              child: Column(
                children: [
                  for (final entry in _consentLabels.entries)
                    SwitchListTile(
                      title: Text(entry.value.$1),
                      subtitle: Text(entry.value.$2),
                      value: map[entry.key] ?? false,
                      onChanged: (value) async {
                        if (!value && entry.key == 'vton_processing') {
                          final ok = await confirmDialog(
                            context,
                            title: 'Withdraw try-on permission?',
                            message: 'Your body photo and every render made from it '
                                'will be deleted immediately.',
                            confirmLabel: 'Withdraw',
                          );
                          if (!ok) return;
                        }
                        await ref
                            .read(accountRepositoryProvider)
                            .setConsent(entry.key, granted: value);
                        ref
                          ..invalidate(consentsProvider)
                          ..invalidate(bodyPhotosProvider);
                      },
                    ),
                ],
              ),
            ),
          ),
          const SizedBox(height: 20),
          TextButton(
            onPressed: () => ref.read(authControllerProvider.notifier).signOut(),
            child: const Text('Sign out'),
          ),
        ],
      ),
    );
  }
}

class _Stat extends StatelessWidget {
  const _Stat({required this.label, required this.value});

  final String label;
  final String value;

  @override
  Widget build(BuildContext context) {
    return Expanded(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(value, style: Theme.of(context).textTheme.headlineSmall),
          Text(label, style: Theme.of(context).textTheme.bodySmall),
        ],
      ),
    );
  }
}
