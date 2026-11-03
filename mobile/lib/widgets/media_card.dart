import 'package:flutter/material.dart';

import '../models.dart';
import '../theme.dart';

class MediaCard extends StatefulWidget {
  const MediaCard({
    super.key,
    required this.item,
    required this.onTap,
    this.coverUrl,
  });

  final MediaItem item;
  final VoidCallback onTap;

  /// 传入经过桌面端代理的封面地址，默认使用条目原始封面。
  final String? coverUrl;

  @override
  State<MediaCard> createState() => _MediaCardState();
}

class _MediaCardState extends State<MediaCard> {
  bool _focused = false;

  @override
  Widget build(BuildContext context) {
    return AnimatedContainer(
      duration: const Duration(milliseconds: 120),
      decoration: BoxDecoration(
        color: kSurface,
        borderRadius: BorderRadius.circular(12),
        border: Border.all(color: _focused ? kAccent : kBorder),
      ),
      child: Material(
        color: Colors.transparent,
        borderRadius: BorderRadius.circular(12),
        child: InkWell(
          borderRadius: BorderRadius.circular(12),
          onTap: widget.onTap,
          onFocusChange: (value) => setState(() => _focused = value),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              ClipRRect(
                borderRadius: const BorderRadius.vertical(top: Radius.circular(11)),
                child: AspectRatio(
                  aspectRatio: 3 / 4,
                  child: _Cover(url: widget.coverUrl ?? widget.item.coverUrl),
                ),
              ),
              Padding(
                padding: const EdgeInsets.fromLTRB(12, 10, 12, 12),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      widget.item.title,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: const TextStyle(fontSize: 14, fontWeight: FontWeight.w600),
                    ),
                    const SizedBox(height: 4),
                    Text(
                      widget.item.siteName,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: const TextStyle(color: kMuted, fontSize: 11),
                    ),
                  ],
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

class _Cover extends StatelessWidget {
  const _Cover({required this.url});

  final String url;

  @override
  Widget build(BuildContext context) {
    if (url.isEmpty) {
      return _placeholder();
    }
    return Image.network(
      url,
      fit: BoxFit.cover,
      errorBuilder: (context, error, stackTrace) => _placeholder(),
      loadingBuilder: (context, child, progress) {
        if (progress == null) {
          return child;
        }
        return ColoredBox(
          color: kSurfaceAlt,
          child: Center(
            child: SizedBox(
              width: 18,
              height: 18,
              child: CircularProgressIndicator(
                strokeWidth: 2,
                value: progress.expectedTotalBytes == null
                    ? null
                    : progress.cumulativeBytesLoaded / progress.expectedTotalBytes!,
              ),
            ),
          ),
        );
      },
    );
  }

  Widget _placeholder() {
    return const ColoredBox(
      color: kSurfaceAlt,
      child: Center(child: Icon(Icons.movie_outlined, color: kMuted, size: 28)),
    );
  }
}
