import 'package:flutter/material.dart';

import '../state/app_controller.dart';
import '../theme.dart';
import '../widgets/media_card.dart';
import 'detail_screen.dart';

class FavoritesScreen extends StatelessWidget {
  const FavoritesScreen({super.key, required this.controller});

  final AppController controller;

  @override
  Widget build(BuildContext context) {
    return AnimatedBuilder(
      animation: controller,
      builder: (context, _) {
        final favorites = controller.favorites;
        return Padding(
          padding: const EdgeInsets.fromLTRB(28, 24, 28, 12),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Row(
                children: [
                  const Text('收藏', style: TextStyle(fontSize: 22, fontWeight: FontWeight.w600)),
                  const SizedBox(width: 10),
                  Text('${favorites.length}', style: const TextStyle(color: kMuted, fontSize: 12)),
                  const Spacer(),
                  IconButton(
                    onPressed: controller.busy ? null : controller.refreshFavorites,
                    icon: const Icon(Icons.refresh),
                    tooltip: '刷新收藏',
                  ),
                ],
              ),
              const SizedBox(height: 16),
              Expanded(
                child: favorites.isEmpty
                    ? const Center(
                        child: Text(
                          '收藏是空的\n在桌面端收藏影片后会同步显示在这里',
                          textAlign: TextAlign.center,
                          style: TextStyle(color: kMuted, height: 1.6),
                        ),
                      )
                    : GridView.builder(
                        padding: const EdgeInsets.only(bottom: 20),
                        gridDelegate: const SliverGridDelegateWithMaxCrossAxisExtent(
                          maxCrossAxisExtent: 210,
                          mainAxisSpacing: 16,
                          crossAxisSpacing: 16,
                          childAspectRatio: 0.58,
                        ),
                        itemCount: favorites.length,
                        itemBuilder: (context, index) {
                          final item = favorites[index];
                          return MediaCard(
                            item: item,
                            coverUrl: controller.imageUrl(item.coverUrl),
                            onTap: () => Navigator.of(context).push(
                              MaterialPageRoute<void>(
                                builder: (_) => DetailScreen(controller: controller, item: item),
                              ),
                            ),
                          );
                        },
                      ),
              ),
            ],
          ),
        );
      },
    );
  }
}
