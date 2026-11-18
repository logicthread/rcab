import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:shared_preferences/shared_preferences.dart';

/// rcab brand palette, shared with the web client: ink for text and primary
/// surfaces, one amber accent. Light and dark are re-picked, not inverted.
class RcabColors {
  RcabColors._();

  static const amber = Color(0xFFFFB414);
  static const amberInk = Color(0xFF14161A); // text on amber, both themes

  // Light
  static const lightInk = Color(0xFF14161A);
  static const lightPaper = Color(0xFFF6F7F9);
  static const lightSurface = Color(0xFFFFFFFF);
  static const lightLine = Color(0xFFE1E4EA);
  static const lightMuted = Color(0xFF5A6270);
  static const lightGo = Color(0xFF0F7B55);
  static const lightStop = Color(0xFFC0262D);

  // Dark
  static const darkInk = Color(0xFFF0F2F5);
  static const darkPaper = Color(0xFF0D0F13);
  static const darkSurface = Color(0xFF171A20);
  static const darkLine = Color(0xFF2C313B);
  static const darkMuted = Color(0xFF98A0AE);
  static const darkGo = Color(0xFF3ECF96);
  static const darkStop = Color(0xFFFF7E82);
}

ThemeData buildTheme(Brightness brightness) {
  final dark = brightness == Brightness.dark;
  final ink = dark ? RcabColors.darkInk : RcabColors.lightInk;
  final paper = dark ? RcabColors.darkPaper : RcabColors.lightPaper;
  final surface = dark ? RcabColors.darkSurface : RcabColors.lightSurface;
  final line = dark ? RcabColors.darkLine : RcabColors.lightLine;
  final muted = dark ? RcabColors.darkMuted : RcabColors.lightMuted;
  final stop = dark ? RcabColors.darkStop : RcabColors.lightStop;
  final onInk = dark ? RcabColors.lightInk : Colors.white;

  final scheme = ColorScheme(
    brightness: brightness,
    primary: ink,
    onPrimary: onInk,
    secondary: RcabColors.amber,
    onSecondary: RcabColors.amberInk,
    tertiary: dark ? RcabColors.darkGo : RcabColors.lightGo,
    onTertiary: onInk,
    error: stop,
    onError: onInk,
    surface: surface,
    onSurface: ink,
    onSurfaceVariant: muted,
    outline: line,
    outlineVariant: line,
    surfaceContainerHighest: paper,
  );

  const radius = BorderRadius.all(Radius.circular(10));
  return ThemeData(
    useMaterial3: true,
    brightness: brightness,
    colorScheme: scheme,
    scaffoldBackgroundColor: paper,
    appBarTheme: AppBarTheme(
      backgroundColor: paper,
      foregroundColor: ink,
      elevation: 0,
      scrolledUnderElevation: 0,
      centerTitle: false,
      titleTextStyle: TextStyle(color: ink, fontSize: 20, fontWeight: FontWeight.w700),
    ),
    drawerTheme: DrawerThemeData(backgroundColor: surface),
    cardTheme: CardThemeData(
      color: surface,
      elevation: 0,
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(16),
        side: BorderSide(color: line),
      ),
    ),
    dividerTheme: DividerThemeData(color: line, space: 1),
    filledButtonTheme: FilledButtonThemeData(
      style: FilledButton.styleFrom(
        minimumSize: const Size(64, 48),
        shape: const RoundedRectangleBorder(borderRadius: radius),
        textStyle: const TextStyle(fontWeight: FontWeight.w700, fontSize: 15),
      ),
    ),
    elevatedButtonTheme: ElevatedButtonThemeData(
      style: ElevatedButton.styleFrom(
        minimumSize: const Size(64, 48),
        backgroundColor: RcabColors.amber,
        foregroundColor: RcabColors.amberInk,
        disabledBackgroundColor: line,
        disabledForegroundColor: muted,
        shape: const RoundedRectangleBorder(borderRadius: radius),
        textStyle: const TextStyle(fontWeight: FontWeight.w700, fontSize: 15),
      ),
    ),
    outlinedButtonTheme: OutlinedButtonThemeData(
      style: OutlinedButton.styleFrom(
        minimumSize: const Size(64, 48),
        foregroundColor: ink,
        side: BorderSide(color: dark ? RcabColors.darkMuted : RcabColors.lightMuted),
        shape: const RoundedRectangleBorder(borderRadius: radius),
      ),
    ),
    inputDecorationTheme: InputDecorationTheme(
      filled: true,
      fillColor: surface,
      border: OutlineInputBorder(borderRadius: radius, borderSide: BorderSide(color: line)),
      enabledBorder: OutlineInputBorder(borderRadius: radius, borderSide: BorderSide(color: line)),
      focusedBorder: OutlineInputBorder(
        borderRadius: radius,
        borderSide: BorderSide(color: ink, width: 2),
      ),
    ),
    snackBarTheme: const SnackBarThemeData(behavior: SnackBarBehavior.floating),
  );
}

/// System / Light / Dark, remembered across launches.
class ThemeModeNotifier extends StateNotifier<ThemeMode> {
  ThemeModeNotifier() : super(ThemeMode.system) {
    _load();
  }

  static const prefKey = 'theme_mode';

  Future<void> _load() async {
    try {
      final prefs = await SharedPreferences.getInstance();
      final saved = prefs.getString(prefKey);
      final mode = ThemeMode.values.where((m) => m.name == saved);
      if (mode.isNotEmpty && mounted) state = mode.first;
    } catch (_) {
      // Storage unavailable: stay on the system theme.
    }
  }

  Future<void> set(ThemeMode mode) async {
    state = mode;
    try {
      final prefs = await SharedPreferences.getInstance();
      await prefs.setString(prefKey, mode.name);
    } catch (_) {
      // Not persisted this time; the choice still applies for this session.
    }
  }
}

final themeModeProvider =
    StateNotifierProvider<ThemeModeNotifier, ThemeMode>((_) => ThemeModeNotifier());
