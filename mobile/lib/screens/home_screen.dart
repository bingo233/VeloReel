import 'package:flutter/material.dart';

import '../state/app_controller.dart';
import '../theme.dart';
import 'favorites_screen.dart';
import 'history_screen.dart';
import 'rules_screen.dart';
import 'search_screen.dart';
import 'settings_screen.dart';

class HomeScreen extends StatefulWidget {
  const HomeScreen({super.key, required this.controller});

  final AppController controller;

  @override
  State<HomeScreen> createState() => _HomeScreenState();
}

class _HomeScreenState extends State<HomeScreen> {
  int _index = 0;

  static const List<_NavItem> _items = <_NavItem>[
    _NavItem(icon: Icons.history, label: '历史'),
    _NavItem(icon: Icons.bookmark_outline, label: '收藏'),
    _NavItem(icon: Icons.search, label: '搜索'),
    _NavItem(icon: Icons.tune, label: '规则'),
    _NavItem(icon: Icons.settings_outlined, label: '设置'),
  ];

  void _select(int value) {
    setState(() => _index = value);
    if (value == 0) {
      widget.controller.refreshHistory();
    }
  }

  @override
  Widget build(BuildContext context) {
    final screens = <Widget>[
      HistoryScreen(controller: widget.controller),
      FavoritesScreen(controller: widget.controller),
      SearchScreen(controller: widget.controller),
      RulesScreen(controller: widget.controller),
      SettingsScreen(controller: widget.controller),
    ];

    return LayoutBuilder(
      builder: (context, constraints) {
        final wide = constraints.maxWidth >= 720;
        if (!wide) {
          return Scaffold(
            body: IndexedStack(index: _index, children: screens),
            bottomNavigationBar: NavigationBar(
              selectedIndex: _index,
              onDestinationSelected: _select,
              backgroundColor: kSurface,
              indicatorColor: kAccent.withValues(alpha: 0.2),
              destinations: const <NavigationDestination>[
                NavigationDestination(icon: Icon(Icons.history), label: '历史'),
                NavigationDestination(icon: Icon(Icons.bookmark_outline), label: '收藏'),
                NavigationDestination(icon: Icon(Icons.search), label: '搜索'),
                NavigationDestination(icon: Icon(Icons.tune), label: '规则'),
                NavigationDestination(icon: Icon(Icons.settings_outlined), label: '设置'),
              ],
            ),
          );
        }
        return Scaffold(
          body: Row(
            children: [
              _Sidebar(
                controller: widget.controller,
                selected: _index,
                items: _items,
                onSelect: _select,
              ),
              Expanded(child: IndexedStack(index: _index, children: screens)),
            ],
          ),
        );
      },
    );
  }
}

class _NavItem {
  const _NavItem({required this.icon, required this.label});

  final IconData icon;
  final String label;
}

class _Sidebar extends StatelessWidget {
  const _Sidebar({
    required this.controller,
    required this.selected,
    required this.items,
    required this.onSelect,
  });

  final AppController controller;
  final int selected;
  final List<_NavItem> items;
  final ValueChanged<int> onSelect;

  @override
  Widget build(BuildContext context) {
    return Container(
      width: 224,
      decoration: const BoxDecoration(
        color: kSurface,
        border: Border(right: BorderSide(color: kBorder)),
      ),
      child: SafeArea(
        child: Padding(
          padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 22),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              const Row(
                children: [
                  Icon(Icons.play_arrow_rounded, color: kAccent),
                  SizedBox(width: 8),
                  Text('VeloReel', style: TextStyle(fontSize: 18, fontWeight: FontWeight.w700)),
                ],
              ),
              const SizedBox(height: 28),
              for (var i = 0; i < items.length; i++)
                Padding(
                  padding: const EdgeInsets.only(bottom: 6),
                  child: _NavTile(
                    icon: items[i].icon,
                    label: items[i].label,
                    active: selected == i,
                    onTap: () => onSelect(i),
                  ),
                ),
              const Spacer(),
              Container(
                width: double.infinity,
                padding: const EdgeInsets.all(12),
                decoration: BoxDecoration(
                  color: kSurfaceAlt,
                  borderRadius: BorderRadius.circular(10),
                ),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Row(
                      children: [
                        const Icon(Icons.circle, size: 8, color: kAccent),
                        const SizedBox(width: 8),
                        Expanded(
                          child: Text(
                            controller.info?.name ?? '已连接',
                            overflow: TextOverflow.ellipsis,
                            style: const TextStyle(fontSize: 13, fontWeight: FontWeight.w600),
                          ),
                        ),
                      ],
                    ),
                    const SizedBox(height: 6),
                    Text(
                      controller.baseUrl ?? '',
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

class _NavTile extends StatelessWidget {
  const _NavTile({
    required this.icon,
    required this.label,
    required this.active,
    required this.onTap,
  });

  final IconData icon;
  final String label;
  final bool active;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    return Material(
      color: active ? kAccent.withValues(alpha: 0.14) : Colors.transparent,
      borderRadius: BorderRadius.circular(10),
      child: InkWell(
        borderRadius: BorderRadius.circular(10),
        onTap: onTap,
        child: Padding(
          padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 13),
          child: Row(
            children: [
              Icon(icon, size: 20, color: active ? kAccent : kMuted),
              const SizedBox(width: 12),
              Text(
                label,
                style: TextStyle(
                  color: active ? kText : kMuted,
                  fontWeight: active ? FontWeight.w600 : FontWeight.w400,
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
