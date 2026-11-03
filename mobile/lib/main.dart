import 'package:flutter/material.dart';

import 'screens/discover_screen.dart';
import 'screens/home_screen.dart';
import 'state/app_controller.dart';
import 'theme.dart';

void main() {
  WidgetsFlutterBinding.ensureInitialized();
  runApp(const VeloReelApp());
}

class VeloReelApp extends StatefulWidget {
  const VeloReelApp({super.key});

  @override
  State<VeloReelApp> createState() => _VeloReelAppState();
}

class _VeloReelAppState extends State<VeloReelApp> {
  final AppController _controller = AppController();

  @override
  void initState() {
    super.initState();
    _controller.init();
  }

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'VeloReel',
      debugShowCheckedModeBanner: false,
      theme: buildAppTheme(),
      home: AnimatedBuilder(
        animation: _controller,
        builder: (context, _) {
          if (_controller.initializing) {
            return const Scaffold(
              body: Center(
                child: Column(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    SizedBox(
                      width: 36,
                      height: 36,
                      child: CircularProgressIndicator(strokeWidth: 3),
                    ),
                    SizedBox(height: 14),
                    Text('正在连接桌面端…', style: TextStyle(color: kMuted, fontSize: 13)),
                  ],
                ),
              ),
            );
          }
          return _controller.connected
              ? HomeScreen(controller: _controller)
              : DiscoverScreen(controller: _controller);
        },
      ),
    );
  }
}
