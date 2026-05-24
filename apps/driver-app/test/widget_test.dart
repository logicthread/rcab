import 'package:driver_app/main.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  testWidgets('app renders scaffold text', (WidgetTester tester) async {
    await tester.pumpWidget(const DriverApp());
    expect(find.text('rcab Driver — Phase 0 scaffold'), findsOneWidget);
  });
}
