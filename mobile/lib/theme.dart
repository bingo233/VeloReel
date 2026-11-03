import 'package:flutter/material.dart';

const Color kBackground = Color(0xFF0B0D10);
const Color kSurface = Color(0xFF15181E);
const Color kSurfaceAlt = Color(0xFF1D222B);
const Color kAccent = Color(0xFF0FDC78);
const Color kText = Color(0xFFE6E8EC);
const Color kMuted = Color(0xFF9BA1AC);
const Color kBorder = Color(0xFF2A303A);
const Color kDanger = Color(0xFFE5534B);

ThemeData buildAppTheme() {
  final scheme = ColorScheme.fromSeed(
    seedColor: kAccent,
    brightness: Brightness.dark,
    surface: kSurface,
  );
  return ThemeData(
    useMaterial3: true,
    colorScheme: scheme,
    scaffoldBackgroundColor: kBackground,
    canvasColor: kBackground,
    fontFamily: 'Roboto',
    textTheme: const TextTheme(
      displaySmall: TextStyle(color: kText, fontSize: 30, fontWeight: FontWeight.w600),
      headlineSmall: TextStyle(color: kText, fontSize: 22, fontWeight: FontWeight.w600),
      titleMedium: TextStyle(color: kText, fontSize: 16, fontWeight: FontWeight.w600),
      bodyMedium: TextStyle(color: kText, fontSize: 14),
      bodySmall: TextStyle(color: kMuted, fontSize: 12),
    ),
    inputDecorationTheme: InputDecorationTheme(
      filled: true,
      fillColor: kSurfaceAlt,
      hintStyle: const TextStyle(color: kMuted),
      contentPadding: const EdgeInsets.symmetric(horizontal: 16, vertical: 14),
      border: OutlineInputBorder(
        borderRadius: BorderRadius.circular(10),
        borderSide: const BorderSide(color: kBorder),
      ),
      enabledBorder: OutlineInputBorder(
        borderRadius: BorderRadius.circular(10),
        borderSide: const BorderSide(color: kBorder),
      ),
      focusedBorder: OutlineInputBorder(
        borderRadius: BorderRadius.circular(10),
        borderSide: const BorderSide(color: kAccent),
      ),
    ),
    elevatedButtonTheme: ElevatedButtonThemeData(
      style: ElevatedButton.styleFrom(
        backgroundColor: kAccent,
        foregroundColor: const Color(0xFF062718),
        minimumSize: const Size(112, 46),
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(10)),
        textStyle: const TextStyle(fontWeight: FontWeight.w600),
      ),
    ),
    snackBarTheme: const SnackBarThemeData(
      backgroundColor: kSurfaceAlt,
      contentTextStyle: TextStyle(color: kText),
      behavior: SnackBarBehavior.floating,
    ),
  );
}
