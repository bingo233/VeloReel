import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:video_player/video_player.dart';
import 'package:wakelock_plus/wakelock_plus.dart';

import '../models.dart';
import '../state/app_controller.dart';
import '../theme.dart';

class PlayerScreen extends StatefulWidget {
  const PlayerScreen({
    super.key,
    required this.url,
    required this.title,
    required this.controller,
    required this.siteId,
    required this.detailUrl,
    required this.coverUrl,
    required this.episodeUrl,
    required this.episodeName,
    this.initialPosition = Duration.zero,
  });

  final String url;
  final String title;
  final AppController controller;
  final String siteId;
  final String detailUrl;
  final String coverUrl;
  final String episodeUrl;
  final String episodeName;

  /// 上次看到的位置，大于零时自动续播。
  final Duration initialPosition;

  @override
  State<PlayerScreen> createState() => _PlayerScreenState();
}

class _PlayerScreenState extends State<PlayerScreen> {
  VideoPlayerController? _controller;
  String? _error;
  bool _controlsVisible = true;
  Timer? _hideTimer;
  Timer? _reportTimer;
  Timer? _hudTimer;

  /// 手势调节：亮度用半透明遮罩模拟，音量直接作用于播放器。
  double _brightness = 1;
  double _volume = 1;
  bool _adjustingBrightness = true;
  double _dragValue = 0;
  Duration? _seekTarget;
  String? _hudText;
  bool _boosting = false;
  String? _castingDeviceId;
  String? _castingDeviceName;
  Timer? _castTimer;
  DlnaPosition? _castPosition;
  bool _castControlBusy = false;

  @override
  void initState() {
    super.initState();
    SystemChrome.setPreferredOrientations(const <DeviceOrientation>[
      DeviceOrientation.landscapeLeft,
      DeviceOrientation.landscapeRight,
    ]);
    // 播放页打开期间保持屏幕常亮，退出时恢复系统策略
    unawaited(WakelockPlus.enable());
    _initialize();
  }

  Future<void> _initialize() async {
    final controller = VideoPlayerController.networkUrl(Uri.parse(widget.url));
    try {
      await controller.initialize();
      final resume = widget.initialPosition;
      if (resume > Duration.zero &&
          resume < controller.value.duration &&
          resume.inSeconds > 1) {
        await controller.seekTo(resume);
      }
      await controller.play();
      if (!mounted) {
        await controller.dispose();
        return;
      }
      setState(() => _controller = controller);
      _scheduleHide();
      _reportTimer = Timer.periodic(const Duration(seconds: 15), (_) {
        unawaited(_reportProgress());
      });
    } catch (exception) {
      await controller.dispose();
      if (!mounted) {
        return;
      }
      setState(() => _error = exception.toString());
    }
  }

  void _scheduleHide() {
    _hideTimer?.cancel();
    _hideTimer = Timer(const Duration(seconds: 4), () {
      if (mounted) {
        setState(() => _controlsVisible = false);
      }
    });
  }

  void _toggleControls() {
    setState(() => _controlsVisible = !_controlsVisible);
    if (_controlsVisible) {
      _scheduleHide();
    }
  }

  void _togglePlay() {
    final controller = _controller;
    if (controller == null) {
      return;
    }
    setState(() {
      if (controller.value.isPlaying) {
        controller.pause();
      } else {
        controller.play();
      }
    });
    _scheduleHide();
  }

  void _showHud(String text, {bool sticky = false}) {
    _hudTimer?.cancel();
    setState(() => _hudText = text);
    if (sticky) {
      return;
    }
    _hudTimer = Timer(const Duration(milliseconds: 1200), () {
      if (mounted) {
        setState(() => _hudText = null);
      }
    });
  }

  void _onVerticalDragStart(DragStartDetails details) {
    final width = context.size?.width ?? MediaQuery.of(context).size.width;
    _adjustingBrightness = details.localPosition.dx < width / 2;
    _dragValue = _adjustingBrightness ? _brightness : _volume;
  }

  void _onVerticalDragUpdate(DragUpdateDetails details) {
    // 向上滑动增大，整屏高度约调节 1.0
    final raw = _dragValue - details.delta.dy / 320;
    if (_adjustingBrightness) {
      final next = raw.clamp(0.2, 1.0);
      _dragValue = next;
      setState(() => _brightness = next);
      _showHud('亮度 ${(next * 100).round()}%');
    } else {
      final next = raw.clamp(0.0, 1.0);
      _dragValue = next;
      setState(() => _volume = next);
      unawaited(_controller?.setVolume(_volume) ?? Future<void>.value());
      _showHud('音量 ${(next * 100).round()}%');
    }
  }

  void _onHorizontalDragStart(DragStartDetails details) {
    final player = _controller;
    if (player == null || !player.value.isInitialized) {
      return;
    }
    _seekTarget = player.value.position;
    setState(() {});
  }

  void _onHorizontalDragUpdate(DragUpdateDetails details) {
    final player = _controller;
    final target = _seekTarget;
    if (player == null || target == null) {
      return;
    }
    final duration = player.value.duration;
    final width = context.size?.width ?? MediaQuery.of(context).size.width;
    if (duration.inMilliseconds <= 0 || width <= 0) {
      return;
    }
    // 横滑整屏宽度对应整段视频时长
    final deltaMs = duration.inMilliseconds * details.delta.dx / width;
    final nextMs = (target.inMilliseconds + deltaMs)
        .clamp(0, duration.inMilliseconds)
        .toInt();
    final next = Duration(milliseconds: nextMs);
    setState(() {
      _seekTarget = next;
      _hudText = '${_format(next)} / ${_format(duration)}';
    });
  }

  void _onHorizontalDragEnd(DragEndDetails details) {
    final target = _seekTarget;
    _seekTarget = null;
    if (target == null) {
      return;
    }
    unawaited(_controller?.seekTo(target) ?? Future<void>.value());
    setState(() => _hudText = null);
    _scheduleHide();
  }

  Future<void> _openCastSheet() async {
    if (!widget.controller.connected) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('尚未连接桌面端')),
      );
      return;
    }
    final outcome = await showModalBottomSheet<_CastOutcome>(
      context: context,
      isScrollControlled: true,
      builder: (_) => _CastSheet(
        controller: widget.controller,
        url: widget.url,
        title: widget.title,
        castingDeviceId: _castingDeviceId,
      ),
    );
    if (outcome == null || !mounted) {
      return;
    }
    if (outcome.stopped) {
      setState(() {
        _castingDeviceId = null;
        _castingDeviceName = null;
      });
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('已停止投屏')),
      );
      return;
    }
    setState(() {
      _castingDeviceId = outcome.id;
      _castingDeviceName = outcome.name;
      _castPosition = null;
    });
    _controller?.pause();
    _startCastPolling();
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(content: Text('已投屏到 ${outcome.name}')),
    );
  }

  void _startCastPolling() {
    _castTimer?.cancel();
    _castTimer = Timer.periodic(const Duration(seconds: 4), (_) {
      unawaited(_pollCastPosition());
    });
    unawaited(_pollCastPosition());
  }

  void _stopCastPolling() {
    _castTimer?.cancel();
    _castTimer = null;
  }

  /// 轮询电视端进度，失败静默，顺便把进度写回观看历史。
  Future<void> _pollCastPosition() async {
    final deviceId = _castingDeviceId;
    if (deviceId == null || !mounted) {
      return;
    }
    try {
      final position = await widget.controller.dlnaPosition(deviceId);
      if (!mounted) {
        return;
      }
      setState(() => _castPosition = position);
      if (position.durationMs > 0) {
        unawaited(_reportCastProgress(position));
      }
    } catch (_) {
      // 部分电视不支持 GetPositionInfo，保持静默仅显示投屏中
    }
  }

  Future<void> _reportCastProgress(DlnaPosition position) async {
    final payload = <String, dynamic>{
      'siteId': widget.siteId,
      'title': widget.title,
      'coverUrl': widget.coverUrl,
      'detailUrl': widget.detailUrl,
      'episodeUrl': widget.episodeUrl,
      'episodeName': widget.episodeName,
      'currentTime': (position.positionMs / 1000).round(),
      'duration': (position.durationMs / 1000).round(),
      'isFinished': position.positionMs / position.durationMs >= 0.95,
      'updatedAt': DateTime.now().millisecondsSinceEpoch,
    };
    try {
      await widget.controller.saveProgress(payload);
    } catch (_) {
      // 不影响投屏
    }
  }

  Future<void> _castControl(String action, {int? positionMs}) async {
    final deviceId = _castingDeviceId;
    if (deviceId == null || _castControlBusy) {
      return;
    }
    setState(() => _castControlBusy = true);
    try {
      await widget.controller.dlnaControl(
        deviceId: deviceId,
        action: action,
        positionMs: positionMs,
      );
      await _pollCastPosition();
    } catch (exception) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text('电视控制失败：$exception')),
        );
      }
    } finally {
      if (mounted) {
        setState(() => _castControlBusy = false);
      }
    }
  }

  Future<void> _stopCasting() async {
    final deviceId = _castingDeviceId;
    if (deviceId == null) {
      return;
    }
    try {
      await widget.controller.dlnaStop(deviceId);
    } catch (_) {
      // 停止失败也退出遥控器状态
    }
    if (!mounted) {
      return;
    }
    setState(() {
      _castingDeviceId = null;
      _castingDeviceName = null;
      _castPosition = null;
    });
    _stopCastPolling();
    ScaffoldMessenger.of(context).showSnackBar(
      const SnackBar(content: Text('已停止投屏')),
    );
  }

  void _setBoost(bool boosting) {
    if (_boosting == boosting) {
      return;
    }
    _boosting = boosting;
    unawaited(_controller?.setPlaybackSpeed(boosting ? 2.0 : 1.0) ?? Future<void>.value());
    if (boosting) {
      _showHud('2.0× 倍速播放中', sticky: true);
    } else {
      _showHud('恢复正常速度');
    }
  }

  /// 上报当前进度，失败静默处理，不打断播放。
  Future<void> _reportProgress() async {
    final player = _controller;
    if (player == null || !player.value.isInitialized) {
      return;
    }
    final value = player.value;
    final durationMs = value.duration.inMilliseconds;
    if (durationMs <= 0) {
      return;
    }
    final positionMs = value.position.inMilliseconds;
    final payload = <String, dynamic>{
      'siteId': widget.siteId,
      'title': widget.title,
      'coverUrl': widget.coverUrl,
      'detailUrl': widget.detailUrl,
      'episodeUrl': widget.episodeUrl,
      'episodeName': widget.episodeName,
      'currentTime': (positionMs / 1000).round(),
      'duration': (durationMs / 1000).round(),
      'isFinished': positionMs / durationMs >= 0.95,
      'updatedAt': DateTime.now().millisecondsSinceEpoch,
    };
    try {
      await widget.controller.saveProgress(payload);
    } catch (_) {
      // 网络波动或已断开连接时忽略，避免影响播放
    }
  }

  @override
  void dispose() {
    _hideTimer?.cancel();
    _reportTimer?.cancel();
    _hudTimer?.cancel();
    _stopCastPolling();
    unawaited(_reportProgress());
    _controller?.dispose();
    unawaited(WakelockPlus.disable());
    SystemChrome.setPreferredOrientations(const <DeviceOrientation>[]);
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: Colors.black,
      body: GestureDetector(
        behavior: HitTestBehavior.opaque,
        onTap: _toggleControls,
        onVerticalDragStart: _onVerticalDragStart,
        onVerticalDragUpdate: _onVerticalDragUpdate,
        onHorizontalDragStart: _onHorizontalDragStart,
        onHorizontalDragUpdate: _onHorizontalDragUpdate,
        onHorizontalDragEnd: _onHorizontalDragEnd,
        onHorizontalDragCancel: () {
          if (_seekTarget != null) {
            setState(() {
              _seekTarget = null;
              _hudText = null;
            });
          }
        },
        onLongPressStart: (_) => _setBoost(true),
        onLongPressEnd: (_) => _setBoost(false),
        onLongPressCancel: () => _setBoost(false),
        child: Stack(
          children: [
            Center(child: _videoArea()),
            // 亮度调节用遮罩模拟，不改变系统亮度
            if (_brightness < 1)
              Positioned.fill(
                child: IgnorePointer(
                  child: ColoredBox(
                    color: Colors.black.withValues(alpha: 1 - _brightness),
                  ),
                ),
              ),
            if (_hudText != null) _hud(),
            if (_controlsVisible) _topBar(),
            if (_controlsVisible && _castingDeviceId != null)
              _castRemoteBar()
            else if (_controlsVisible && _controller != null)
              _bottomBar(),
            if (_error != null) _errorView(),
          ],
        ),
      ),
    );
  }

  Widget _videoArea() {
    final controller = _controller;
    if (controller == null) {
      return const SizedBox(
        width: 36,
        height: 36,
        child: CircularProgressIndicator(strokeWidth: 2),
      );
    }
    return AspectRatio(
      aspectRatio: controller.value.aspectRatio,
      child: VideoPlayer(controller),
    );
  }

  Widget _topBar() {
    return Positioned(
      top: 0,
      left: 0,
      right: 0,
      child: SafeArea(
        child: Container(
          padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 8),
          decoration: const BoxDecoration(
            gradient: LinearGradient(
              begin: Alignment.topCenter,
              end: Alignment.bottomCenter,
              colors: <Color>[Color(0xCC000000), Colors.transparent],
            ),
          ),
          child: Row(
            children: [
              IconButton(
                onPressed: () => Navigator.of(context).maybePop(),
                icon: const Icon(Icons.arrow_back, color: Colors.white),
              ),
              Expanded(
                child: Text(
                  widget.title,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: const TextStyle(color: Colors.white, fontSize: 15),
                ),
              ),
              IconButton(
                onPressed: _openCastSheet,
                tooltip: _castingDeviceName == null
                    ? '投屏到电视'
                    : '正在投屏到 $_castingDeviceName',
                icon: Icon(
                  Icons.cast,
                  color: _castingDeviceName == null ? Colors.white : kAccent,
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }

  Widget _bottomBar() {
    final controller = _controller!;
    return Positioned(
      left: 0,
      right: 0,
      bottom: 0,
      child: Container(
        padding: const EdgeInsets.fromLTRB(16, 24, 16, 12),
        decoration: const BoxDecoration(
          gradient: LinearGradient(
            begin: Alignment.bottomCenter,
            end: Alignment.topCenter,
            colors: <Color>[Color(0xE6000000), Colors.transparent],
          ),
        ),
        child: ValueListenableBuilder<VideoPlayerValue>(
          valueListenable: controller,
          builder: (context, value, _) {
            final position = value.position;
            final duration = value.duration;
            return Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                VideoProgressIndicator(
                  controller,
                  allowScrubbing: true,
                  colors: const VideoProgressColors(
                    playedColor: kAccent,
                    bufferedColor: Color(0xFF5A6472),
                    backgroundColor: Color(0xFF2A303A),
                  ),
                ),
                const SizedBox(height: 6),
                Row(
                  children: [
                    IconButton(
                      onPressed: _togglePlay,
                      icon: Icon(
                        value.isPlaying ? Icons.pause : Icons.play_arrow,
                        color: Colors.white,
                      ),
                    ),
                    Text('${_format(position)} / ${_format(duration)}',
                        style: const TextStyle(color: Colors.white70, fontSize: 12)),
                    const Spacer(),
                    if (value.isBuffering)
                      const SizedBox(
                        width: 16,
                        height: 16,
                        child: CircularProgressIndicator(strokeWidth: 2),
                      ),
                  ],
                ),
                const SizedBox(height: 2),
                const Text(
                  '左右滑动进度 · 左侧上下调亮度 · 右侧上下调音量 · 长按 2× 倍速',
                  style: TextStyle(color: Colors.white54, fontSize: 11),
                ),
              ],
            );
          },
        ),
      ),
    );
  }

  /// 投屏遥控器：显示电视进度，可暂停/继续、拖动、停止。
  Widget _castRemoteBar() {
    final position = _castPosition;
    final positionMs = position?.positionMs ?? 0;
    final durationMs = position?.durationMs ?? 0;
    final playing = position?.playing ?? true;
    final progressValue =
        durationMs > 0 ? (positionMs / durationMs).clamp(0.0, 1.0) : 0.0;
    return Positioned(
      left: 0,
      right: 0,
      bottom: 0,
      child: Container(
        padding: const EdgeInsets.fromLTRB(16, 24, 16, 12),
        decoration: const BoxDecoration(
          gradient: LinearGradient(
            begin: Alignment.bottomCenter,
            end: Alignment.topCenter,
            colors: <Color>[Color(0xE6000000), Colors.transparent],
          ),
        ),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Slider(
              value: progressValue,
              onChanged: durationMs > 0
                  ? (value) {
                      setState(() {
                        _castPosition = DlnaPosition(
                          positionMs: (value * durationMs).round(),
                          durationMs: durationMs,
                          state: position?.state ?? 'PLAYING',
                        );
                      });
                    }
                  : null,
              onChangeEnd: durationMs > 0
                  ? (value) => unawaited(
                        _castControl('seek', positionMs: (value * durationMs).round()),
                      )
                  : null,
              activeColor: kAccent,
              inactiveColor: const Color(0xFF2A303A),
            ),
            Row(
              children: [
                IconButton(
                  onPressed:
                      _castControlBusy ? null : () => _castControl(playing ? 'pause' : 'play'),
                  icon: Icon(
                    playing ? Icons.pause : Icons.play_arrow,
                    color: Colors.white,
                  ),
                ),
                Text(
                  durationMs > 0
                      ? '${_format(Duration(milliseconds: positionMs))} / ${_format(Duration(milliseconds: durationMs))}'
                      : '投屏中',
                  style: const TextStyle(color: Colors.white70, fontSize: 12),
                ),
                const Spacer(),
                TextButton.icon(
                  onPressed: _castControlBusy ? null : _stopCasting,
                  icon: const Icon(Icons.stop, color: kDanger, size: 18),
                  label: const Text('停止投屏', style: TextStyle(color: kDanger, fontSize: 12)),
                ),
              ],
            ),
            const SizedBox(height: 2),
            Text(
              '正在投屏到 ${_castingDeviceName ?? '电视'} · 电视进度每 4 秒同步',
              style: const TextStyle(color: Colors.white54, fontSize: 11),
            ),
          ],
        ),
      ),
    );
  }

  Widget _hud() {
    return Positioned(
      top: 76,
      left: 0,
      right: 0,
      child: IgnorePointer(
        child: Center(
          child: Container(
            padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 8),
            decoration: BoxDecoration(
              color: const Color(0xCC000000),
              borderRadius: BorderRadius.circular(8),
            ),
            child: Text(
              _hudText!,
              style: const TextStyle(color: Colors.white, fontSize: 13),
            ),
          ),
        ),
      ),
    );
  }

  Widget _errorView() {
    return Center(
      child: Container(
        padding: const EdgeInsets.all(20),
        margin: const EdgeInsets.all(24),
        decoration: BoxDecoration(
          color: kSurface,
          borderRadius: BorderRadius.circular(12),
        ),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            const Icon(Icons.error_outline, color: kDanger),
            const SizedBox(height: 10),
            Text(
              _error!,
              textAlign: TextAlign.center,
              style: const TextStyle(color: kMuted, fontSize: 12),
            ),
            const SizedBox(height: 14),
            ElevatedButton(
              onPressed: () => Navigator.of(context).maybePop(),
              child: const Text('返回'),
            ),
          ],
        ),
      ),
    );
  }

  String _format(Duration duration) {
    final minutes = duration.inMinutes.remainder(60).toString().padLeft(2, '0');
    final seconds = duration.inSeconds.remainder(60).toString().padLeft(2, '0');
    if (duration.inHours > 0) {
      return '${duration.inHours}:$minutes:$seconds';
    }
    return '$minutes:$seconds';
  }
}

class _CastOutcome {
  const _CastOutcome({required this.id, required this.name, this.stopped = false});

  final String id;
  final String name;
  final bool stopped;
}

class _CastSheet extends StatefulWidget {
  const _CastSheet({
    required this.controller,
    required this.url,
    required this.title,
    required this.castingDeviceId,
  });

  final AppController controller;
  final String url;
  final String title;
  final String? castingDeviceId;

  @override
  State<_CastSheet> createState() => _CastSheetState();
}

class _CastSheetState extends State<_CastSheet> {
  List<DlnaDevice>? _devices;
  String? _error;
  String? _busyId;
  bool _loading = true;

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
      final devices = await widget.controller.dlnaDevices();
      if (!mounted) {
        return;
      }
      setState(() {
        _devices = devices;
        _loading = false;
      });
    } catch (exception) {
      if (!mounted) {
        return;
      }
      setState(() {
        _error = exception.toString();
        _loading = false;
      });
    }
  }

  Future<void> _cast(DlnaDevice device) async {
    setState(() {
      _busyId = device.id;
      _error = null;
    });
    try {
      await widget.controller.dlnaCast(
        deviceId: device.id,
        url: widget.url,
        title: widget.title,
      );
      if (!mounted) {
        return;
      }
      Navigator.of(context).pop(_CastOutcome(id: device.id, name: device.name));
    } catch (exception) {
      if (!mounted) {
        return;
      }
      setState(() {
        _error = exception.toString();
        _busyId = null;
      });
    }
  }

  Future<void> _stop() async {
    final id = widget.castingDeviceId;
    if (id == null) {
      return;
    }
    setState(() => _busyId = id);
    try {
      await widget.controller.dlnaStop(id);
      if (!mounted) {
        return;
      }
      Navigator.of(context).pop(_CastOutcome(id: id, name: '', stopped: true));
    } catch (exception) {
      if (!mounted) {
        return;
      }
      setState(() {
        _error = exception.toString();
        _busyId = null;
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    final maxHeight = MediaQuery.of(context).size.height * 0.6;
    return SafeArea(
      child: ConstrainedBox(
        constraints: BoxConstraints(maxHeight: maxHeight),
        child: Padding(
          padding: const EdgeInsets.fromLTRB(20, 16, 20, 16),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Row(
                children: [
                  const Text('投屏到电视',
                      style: TextStyle(fontSize: 16, fontWeight: FontWeight.w600)),
                  const Spacer(),
                  IconButton(
                    onPressed: () => Navigator.of(context).maybePop(),
                    icon: const Icon(Icons.close),
                  ),
                ],
              ),
              if (widget.castingDeviceId != null)
                ListTile(
                  contentPadding: EdgeInsets.zero,
                  leading: const Icon(Icons.cast_connected, color: kAccent),
                  title: const Text('正在投屏'),
                  trailing: TextButton(
                    onPressed: _busyId == null ? _stop : null,
                    child: _busyId == widget.castingDeviceId
                        ? const SizedBox(
                            width: 14,
                            height: 14,
                            child: CircularProgressIndicator(strokeWidth: 2),
                          )
                        : const Text('停止投屏'),
                  ),
                ),
              if (_loading)
                const Padding(
                  padding: EdgeInsets.symmetric(vertical: 24),
                  child: Center(child: CircularProgressIndicator()),
                )
              else if (_error != null)
                Padding(
                  padding: const EdgeInsets.symmetric(vertical: 12),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(_error!, style: const TextStyle(color: kDanger, fontSize: 12)),
                      const SizedBox(height: 8),
                      OutlinedButton(onPressed: _load, child: const Text('重试')),
                    ],
                  ),
                )
              else if (_devices == null || _devices!.isEmpty)
                const Padding(
                  padding: EdgeInsets.symmetric(vertical: 20),
                  child: Text(
                    '没有发现支持 DLNA 的电视\n请确认电视与电脑在同一 Wi-Fi，并已开启投屏功能',
                    style: TextStyle(color: kMuted, fontSize: 12, height: 1.5),
                  ),
                )
              else
                Flexible(
                  child: ListView.builder(
                    shrinkWrap: true,
                    itemCount: _devices!.length,
                    itemBuilder: (context, index) {
                      final device = _devices![index];
                      final busy = _busyId == device.id;
                      return ListTile(
                        contentPadding: EdgeInsets.zero,
                        leading: const Icon(Icons.tv),
                        title: Text(device.name),
                        subtitle: device.model.isEmpty ? null : Text(device.model),
                        trailing: busy
                            ? const SizedBox(
                                width: 16,
                                height: 16,
                                child: CircularProgressIndicator(strokeWidth: 2),
                              )
                            : const Icon(Icons.cast),
                        enabled: _busyId == null,
                        onTap: () => _cast(device),
                      );
                    },
                  ),
                ),
            ],
          ),
        ),
      ),
    );
  }
}
