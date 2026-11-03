import 'package:flutter/material.dart';

import '../models.dart';
import '../state/app_controller.dart';
import '../theme.dart';
import '../widgets/media_card.dart';
import 'detail_screen.dart';

class SearchScreen extends StatefulWidget {
  const SearchScreen({super.key, required this.controller});

  final AppController controller;

  @override
  State<SearchScreen> createState() => _SearchScreenState();
}

class _SearchScreenState extends State<SearchScreen> {
  final TextEditingController _keywordController = TextEditingController();
  String _siteId = '';
  List<MediaItem> _results = const <MediaItem>[];
  bool _loading = false;
  String? _error;
  bool _searched = false;

  @override
  void dispose() {
    _keywordController.dispose();
    super.dispose();
  }

  Future<void> _search() async {
    final keyword = _keywordController.text.trim();
    if (keyword.isEmpty) {
      return;
    }
    setState(() {
      _loading = true;
      _error = null;
      _searched = true;
    });
    try {
      final results = await widget.controller.search(
        keyword,
        siteId: _siteId.isEmpty ? null : _siteId,
      );
      if (!mounted) {
        return;
      }
      setState(() => _results = results);
    } catch (exception) {
      if (!mounted) {
        return;
      }
      setState(() {
        _results = const <MediaItem>[];
        _error = exception.toString();
      });
    } finally {
      if (mounted) {
        setState(() => _loading = false);
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.fromLTRB(28, 24, 28, 12),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          const Text('搜索', style: TextStyle(fontSize: 22, fontWeight: FontWeight.w600)),
          const SizedBox(height: 16),
          Row(
            children: [
              Expanded(
                child: TextField(
                  controller: _keywordController,
                  textInputAction: TextInputAction.search,
                  onSubmitted: (_) => _search(),
                  decoration: const InputDecoration(
                    hintText: '输入影片名称',
                    prefixIcon: Icon(Icons.search, color: kMuted),
                  ),
                ),
              ),
              const SizedBox(width: 12),
              SizedBox(
                width: 168,
                child: DropdownButtonFormField<String>(
                  initialValue: _siteId,
                  isExpanded: true,
                  decoration: const InputDecoration(contentPadding: EdgeInsets.symmetric(horizontal: 12)),
                  dropdownColor: kSurfaceAlt,
                  items: <DropdownMenuItem<String>>[
                    const DropdownMenuItem<String>(value: '', child: Text('全部站点')),
                    ...widget.controller.sites.map(
                      (site) => DropdownMenuItem<String>(value: site.siteId, child: Text(site.siteName)),
                    ),
                  ],
                  onChanged: (value) => setState(() => _siteId = value ?? ''),
                ),
              ),
              const SizedBox(width: 12),
              ElevatedButton(
                onPressed: _loading ? null : _search,
                child: _loading
                    ? const SizedBox(width: 18, height: 18, child: CircularProgressIndicator(strokeWidth: 2))
                    : const Text('搜索'),
              ),
            ],
          ),
          const SizedBox(height: 18),
          if (_error != null)
            Padding(
              padding: const EdgeInsets.only(bottom: 12),
              child: Text(_error!, style: const TextStyle(color: kDanger, fontSize: 12)),
            ),
          Expanded(
            child: !_searched
                ? const Center(
                    child: Text('输入关键词开始搜索', style: TextStyle(color: kMuted)),
                  )
                : _results.isEmpty && !_loading
                    ? const Center(
                        child: Text('没有找到结果', style: TextStyle(color: kMuted)),
                      )
                    : GridView.builder(
                        padding: const EdgeInsets.only(bottom: 20),
                        gridDelegate: const SliverGridDelegateWithMaxCrossAxisExtent(
                          maxCrossAxisExtent: 210,
                          mainAxisSpacing: 16,
                          crossAxisSpacing: 16,
                          childAspectRatio: 0.58,
                        ),
                        itemCount: _results.length,
                        itemBuilder: (context, index) {
                          final item = _results[index];
                          return MediaCard(
                            item: item,
                            coverUrl: widget.controller.imageUrl(item.coverUrl),
                            onTap: () => Navigator.of(context).push(
                              MaterialPageRoute<void>(
                                builder: (_) => DetailScreen(controller: widget.controller, item: item),
                              ),
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
