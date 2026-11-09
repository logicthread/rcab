import 'dart:async';

import 'package:flutter/material.dart';

/// Recording chrome for the demo harness (TEST-HARNESS ONLY, never shipped):
///
/// - a caption strip above the app naming the scene and the state transition
///   being shown (driven by [DemoChrome.caption]);
/// - an opening title card ([DemoChrome.titleCard]);
/// - a touch indicator, so taps synthesised by `WidgetTester` are visible in
///   the screen recording (Android's "show taps" only sees real input).
///
/// The app is laid out *below* the caption strip, so the strip never hides UI.
class DemoChrome extends StatefulWidget {
  const DemoChrome({super.key, required this.scene, required this.child});

  /// Scene id shown at the left of the caption strip, e.g. `D04`.
  final String scene;
  final Widget child;

  static final caption = ValueNotifier<String>('');
  static final titleCard = ValueNotifier<DemoTitle?>(null);

  @override
  State<DemoChrome> createState() => _DemoChromeState();
}

class DemoTitle {
  const DemoTitle(this.heading, this.lines);
  final String heading;
  final List<String> lines;
}

class _Touch {
  _Touch(this.position) : born = DateTime.now();
  final Offset position;
  final DateTime born;
}

class _DemoChromeState extends State<DemoChrome> {
  static const _strip = 64.0;
  final _touches = <_Touch>[];
  Timer? _fade;

  void _onDown(PointerDownEvent e) {
    setState(() => _touches.add(_Touch(e.position)));
    _fade ??= Timer.periodic(const Duration(milliseconds: 50), (_) {
      final now = DateTime.now();
      setState(() => _touches.removeWhere((t) => now.difference(t.born).inMilliseconds > 700));
      if (_touches.isEmpty) {
        _fade?.cancel();
        _fade = null;
      }
    });
  }

  @override
  void dispose() {
    _fade?.cancel();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final mq = MediaQueryData.fromView(View.of(context));
    final top = mq.padding.top;
    return Directionality(
      textDirection: TextDirection.ltr,
      child: Listener(
        behavior: HitTestBehavior.translucent,
        onPointerDown: _onDown,
        child: Stack(
          children: [
            Column(
              children: [
                _CaptionStrip(scene: widget.scene, height: top + _strip, topPad: top),
                Expanded(
                  child: MediaQuery(
                    data: mq.copyWith(
                      padding: mq.padding.copyWith(top: 0),
                      viewPadding: mq.viewPadding.copyWith(top: 0),
                      size: Size(mq.size.width, mq.size.height - top - _strip),
                    ),
                    child: widget.child,
                  ),
                ),
              ],
            ),
            IgnorePointer(
              child: CustomPaint(size: Size.infinite, painter: _TouchPainter(List.of(_touches))),
            ),
            ValueListenableBuilder<DemoTitle?>(
              valueListenable: DemoChrome.titleCard,
              builder: (_, t, __) => IgnorePointer(
                child: AnimatedOpacity(
                  opacity: t == null ? 0 : 1,
                  duration: const Duration(milliseconds: 400),
                  child: t == null ? const SizedBox.shrink() : _TitleCard(scene: widget.scene, title: t),
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class _CaptionStrip extends StatelessWidget {
  const _CaptionStrip({required this.scene, required this.height, required this.topPad});
  final String scene;
  final double height;
  final double topPad;

  @override
  Widget build(BuildContext context) {
    return Container(
      height: height,
      color: const Color(0xFF101828),
      padding: EdgeInsets.fromLTRB(10, topPad + 6, 10, 6),
      child: Row(
        children: [
          Container(
            padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
            decoration: BoxDecoration(
              color: const Color(0xFFF79009),
              borderRadius: BorderRadius.circular(6),
            ),
            child: Text(
              scene,
              style: const TextStyle(color: Color(0xFF101828), fontWeight: FontWeight.w800, fontSize: 14),
            ),
          ),
          const SizedBox(width: 10),
          Expanded(
            child: ValueListenableBuilder<String>(
              valueListenable: DemoChrome.caption,
              builder: (_, text, __) => Text(
                text,
                maxLines: 2,
                overflow: TextOverflow.ellipsis,
                style: const TextStyle(color: Colors.white, fontSize: 13, height: 1.25, decoration: TextDecoration.none),
              ),
            ),
          ),
        ],
      ),
    );
  }
}

class _TitleCard extends StatelessWidget {
  const _TitleCard({required this.scene, required this.title});
  final String scene;
  final DemoTitle title;

  @override
  Widget build(BuildContext context) {
    return Container(
      color: const Color(0xF2101828),
      padding: const EdgeInsets.all(28),
      alignment: Alignment.centerLeft,
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            'rcab driver app · $scene',
            style: const TextStyle(color: Color(0xFFF79009), fontSize: 15, fontWeight: FontWeight.w700, decoration: TextDecoration.none),
          ),
          const SizedBox(height: 10),
          Text(
            title.heading,
            style: const TextStyle(color: Colors.white, fontSize: 26, fontWeight: FontWeight.w800, height: 1.15, decoration: TextDecoration.none),
          ),
          const SizedBox(height: 18),
          for (final l in title.lines)
            Padding(
              padding: const EdgeInsets.only(bottom: 6),
              child: Text(
                '•  $l',
                style: const TextStyle(color: Color(0xFFD0D5DD), fontSize: 15, height: 1.3, decoration: TextDecoration.none),
              ),
            ),
        ],
      ),
    );
  }
}

class _TouchPainter extends CustomPainter {
  _TouchPainter(this.touches);
  final List<_Touch> touches;

  @override
  void paint(Canvas canvas, Size size) {
    final now = DateTime.now();
    for (final t in touches) {
      final age = now.difference(t.born).inMilliseconds / 700.0;
      final a = (1 - age).clamp(0.0, 1.0);
      canvas.drawCircle(
        t.position,
        22 + 18 * age,
        Paint()..color = Color.fromRGBO(247, 144, 9, 0.45 * a),
      );
      canvas.drawCircle(
        t.position,
        22 + 18 * age,
        Paint()
          ..style = PaintingStyle.stroke
          ..strokeWidth = 3
          ..color = Color.fromRGBO(247, 144, 9, a),
      );
    }
  }

  @override
  bool shouldRepaint(_TouchPainter old) => true;
}
