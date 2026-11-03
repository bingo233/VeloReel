import 'dart:convert';

import 'package:flutter/material.dart';

import '../state/app_controller.dart';
import '../theme.dart';

class RulesScreen extends StatefulWidget {
  const RulesScreen({super.key, required this.controller});

  final AppController controller;

  @override
  State<RulesScreen> createState() => _RulesScreenState();
}

class _RulesScreenState extends State<RulesScreen> {
  List<Map<String, dynamic>> _rules = const <Map<String, dynamic>>[];
  bool _loading = true;
  String? _error;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      final rules = await widget.controller.loadRules();
      if (!mounted) {
        return;
      }
      setState(() => _rules = rules);
    } catch (exception) {
      if (!mounted) {
        return;
      }
      setState(() {
        _rules = const <Map<String, dynamic>>[];
        _error = exception.toString();
      });
    } finally {
      if (mounted) {
        setState(() => _loading = false);
      }
    }
  }

  Future<void> _edit(Map<String, dynamic> rule) async {
    final siteId = rule['siteId'];
    if (siteId is! String || siteId.isEmpty) {
      return;
    }
    final saved = await Navigator.of(context).push<bool>(
      MaterialPageRoute<bool>(
        builder: (_) => RuleEditorScreen(
          controller: widget.controller,
          siteId: siteId,
          rule: rule,
        ),
      ),
    );
    if (saved == true) {
      await _load();
    }
  }

  Future<void> _delete(Map<String, dynamic> rule) async {
    final siteId = rule['siteId'];
    if (siteId is! String || siteId.isEmpty) {
      return;
    }
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        backgroundColor: kSurfaceAlt,
        title: const Text('删除规则'),
        content: Text('确定删除站点「${rule['siteName'] ?? siteId}」的规则吗？'),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(context).pop(false),
            child: const Text('取消'),
          ),
          TextButton(
            onPressed: () => Navigator.of(context).pop(true),
            child: const Text('删除', style: TextStyle(color: kDanger)),
          ),
        ],
      ),
    );
    if (confirmed != true) {
      return;
    }
    try {
      await widget.controller.deleteRule(siteId);
      await _load();
    } catch (exception) {
      if (!mounted) {
        return;
      }
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text(exception.toString())),
      );
    }
  }

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.fromLTRB(28, 24, 28, 12),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              const Text('站点规则', style: TextStyle(fontSize: 22, fontWeight: FontWeight.w600)),
              const SizedBox(width: 10),
              Text('${_rules.length}', style: const TextStyle(color: kMuted, fontSize: 12)),
              const Spacer(),
              IconButton(
                onPressed: _loading ? null : _load,
                icon: const Icon(Icons.refresh),
                tooltip: '刷新规则',
              ),
            ],
          ),
          const SizedBox(height: 8),
          const Text(
            '规则保存在桌面端，修改后会立即生效并清除该站点的流缓存。',
            style: TextStyle(color: kMuted, fontSize: 12),
          ),
          const SizedBox(height: 16),
          if (_error != null)
            Padding(
              padding: const EdgeInsets.only(bottom: 12),
              child: Text(_error!, style: const TextStyle(color: kDanger, fontSize: 12)),
            ),
          Expanded(
            child: _loading
                ? const Center(child: CircularProgressIndicator())
                : _rules.isEmpty
                    ? const Center(
                        child: Text('暂无站点规则\n请先在桌面端添加规则', style: TextStyle(color: kMuted, height: 1.6)),
                      )
                    : ListView.separated(
                        padding: const EdgeInsets.only(bottom: 20),
                        itemCount: _rules.length,
                        separatorBuilder: (context, index) => const SizedBox(height: 10),
                        itemBuilder: (context, index) {
                          final rule = _rules[index];
                          final siteName = rule['siteName'];
                          final siteId = rule['siteId'] as String;
                          final baseUrl = rule['baseUrl'];
                          return Material(
                            color: kSurface,
                            borderRadius: BorderRadius.circular(12),
                            child: InkWell(
                              borderRadius: BorderRadius.circular(12),
                              onTap: () => _edit(rule),
                              child: Padding(
                                padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
                                child: Row(
                                  children: [
                                    const Icon(Icons.tune, size: 18, color: kAccent),
                                    const SizedBox(width: 12),
                                    Expanded(
                                      child: Column(
                                        crossAxisAlignment: CrossAxisAlignment.start,
                                        children: [
                                          Text(
                                            siteName is String && siteName.isNotEmpty ? siteName : siteId,
                                            maxLines: 1,
                                            overflow: TextOverflow.ellipsis,
                                            style: const TextStyle(fontSize: 14, fontWeight: FontWeight.w600),
                                          ),
                                          const SizedBox(height: 4),
                                          Text(
                                            baseUrl is String ? baseUrl : siteId,
                                            maxLines: 1,
                                            overflow: TextOverflow.ellipsis,
                                            style: const TextStyle(color: kMuted, fontSize: 11),
                                          ),
                                        ],
                                      ),
                                    ),
                                    IconButton(
                                      onPressed: () => _edit(rule),
                                      icon: const Icon(Icons.edit_outlined, color: kMuted),
                                      tooltip: '编辑',
                                    ),
                                    IconButton(
                                      onPressed: () => _delete(rule),
                                      icon: const Icon(Icons.delete_outline, color: kMuted),
                                      tooltip: '删除',
                                    ),
                                  ],
                                ),
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

class RuleEditorScreen extends StatefulWidget {
  const RuleEditorScreen({
    super.key,
    required this.controller,
    required this.siteId,
    required this.rule,
  });

  final AppController controller;
  final String siteId;
  final Map<String, dynamic> rule;

  @override
  State<RuleEditorScreen> createState() => _RuleEditorScreenState();
}

class _RuleEditorScreenState extends State<RuleEditorScreen> {
  static const JsonEncoder _encoder = JsonEncoder.withIndent('  ');

  late final TextEditingController _textController = TextEditingController(
    text: _encoder.convert(widget.rule),
  );
  bool _saving = false;

  @override
  void dispose() {
    _textController.dispose();
    super.dispose();
  }

  Future<void> _save() async {
    Map<String, dynamic> decoded;
    try {
      final value = jsonDecode(_textController.text);
      if (value is! Map<String, dynamic>) {
        throw const FormatException('规则必须是 JSON 对象');
      }
      decoded = value;
    } catch (exception) {
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text('JSON 解析失败：$exception')),
      );
      return;
    }
    setState(() => _saving = true);
    try {
      await widget.controller.saveRule(widget.siteId, decoded);
      if (!mounted) {
        return;
      }
      Navigator.of(context).pop(true);
    } catch (exception) {
      if (!mounted) {
        return;
      }
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text(exception.toString())),
      );
    } finally {
      if (mounted) {
        setState(() => _saving = false);
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        backgroundColor: kSurface,
        title: Text('编辑规则 · ${widget.siteId}'),
        actions: [
          TextButton(
            onPressed: _saving ? null : _save,
            child: _saving
                ? const SizedBox(
                    width: 16,
                    height: 16,
                    child: CircularProgressIndicator(strokeWidth: 2),
                  )
                : const Text('保存'),
          ),
        ],
      ),
      body: Padding(
        padding: const EdgeInsets.all(16),
        child: TextField(
          controller: _textController,
          maxLines: null,
          expands: true,
          textAlignVertical: TextAlignVertical.top,
          style: const TextStyle(fontFamily: 'monospace', fontSize: 13, height: 1.4),
          decoration: const InputDecoration(
            hintText: '站点规则 JSON',
            contentPadding: EdgeInsets.all(14),
          ),
        ),
      ),
    );
  }
}
