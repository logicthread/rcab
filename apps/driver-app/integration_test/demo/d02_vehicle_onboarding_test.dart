// D02 — Vehicle registration / onboarding. A freshly verified driver with no
// vehicle (fixture "Demo Driver B3 (new)") cannot go online: the server answers
// 400 no_vehicle_selected. The driver registers a vehicle (POST /v1/vehicles),
// selects it (PATCH /v1/drivers/me/vehicle) and goes online.
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'support/demo_chrome.dart';
import 'support/harness.dart';

void main() {
  Demo.ensureBinding();

  testWidgets('D02 vehicle onboarding', (tester) async {
    final demo = Demo('D02');
    await demo.boot(
      tester,
      title: const DemoTitle('Vehicle onboarding', [
        'No current vehicle → go online refused (400 no_vehicle_selected)',
        'Profile → Add vehicle → POST /v1/vehicles',
        'Select → PATCH /v1/drivers/me/vehicle (server-side current vehicle)',
        'Go online succeeds',
      ]),
    );

    await demo.say('A newly verified driver with no vehicle tries to go online…', hold: 2);
    await demo.tap(find.byKey(const Key('online_toggle')));
    await demo.waitFor(find.byKey(const Key('no_vehicle_snackbar')), timeout: 15, what: 'no-vehicle snackbar');
    await demo.say('Server refuses: 400 no_vehicle_selected → "select a vehicle"', hold: 3.5);

    await demo.say('Profile & vehicles');
    await demo.tap(find.byKey(const Key('profile_button')));
    await demo.waitFor(find.byKey(const Key('empty_state_label')), what: 'empty vehicle list');
    await demo.say('GET /v1/vehicles → none registered yet', hold: 2.5);
    await demo.tap(find.byKey(const Key('add_vehicle_button')));
    await demo.waitFor(find.byKey(const Key('vehicle_form_screen')));

    await demo.say('Every field is validated before anything is sent');
    await demo.tap(find.byKey(const Key('submit_button')), after: 2.5);

    await demo.say('Fill in the vehicle: type, registration, make, model, colour, seats');
    await demo.tap(find.byKey(const Key('type_dropdown')), after: 1);
    await demo.tap(find.text('cab_hatch').last, before: 0.4);
    await demo.type(find.byKey(const Key('reg_no_field')), 'AS01DB0003');
    await demo.type(find.byKey(const Key('make_field')), 'Maruti');
    await demo.type(find.byKey(const Key('model_field')), 'Swift');
    await demo.type(find.byKey(const Key('color_field')), 'Red');
    await demo.type(find.byKey(const Key('seats_field')), '4');
    FocusManager.instance.primaryFocus?.unfocus(); // dismiss the soft keyboard
    await demo.wait(0.8);
    await demo.say('Submit → POST /v1/vehicles');
    await demo.tap(find.byKey(const Key('submit_button')));

    await demo.waitFor(find.byKey(const Key('vehicle_list')), timeout: 15, what: 'vehicle list');
    await demo.say('Registered. Select makes it the current vehicle on the server', hold: 2);
    await demo.tap(find.widgetWithText(ElevatedButton, 'Select'));
    await demo.waitFor(find.byKey(const Key('vehicle_selected_snackbar')), timeout: 15);
    await demo.say('PATCH /v1/drivers/me/vehicle → "Selected"', hold: 3);

    await demo.tap(find.byTooltip('Back'));
    await demo.waitFor(find.text('You are offline'));
    await demo.say('Now going online works');
    await demo.tap(find.byKey(const Key('online_toggle')));
    await demo.waitFor(find.text('You are online'), timeout: 30, what: 'online');
    final p = await demo.cue('presence', {'driver': 'new'});
    await demo.say('Online · in the dispatch geo index: ${p['inGeoIndex']} · DB availability=${p['availability']}',
        hold: 4);
    await demo.tap(find.byKey(const Key('online_toggle')));
    await demo.waitFor(find.text('You are offline'), what: 'offline');
    await demo.end(caption: 'Onboarded: vehicle registered + selected, presence works', hold: 3);
  });
}
