
import { reconcileSnapshots } from '../services/reconciliationService';
import { PatientSnapshot } from '../types';

declare global {
  interface Window {
    runMedicalTests: () => void;
  }
}

const createSnapshot = (day: number, name: string, rut: string, status: any = 'HOSPITALIZED'): PatientSnapshot => {
  const date = new Date(2025, 0, day); // Jan 2025
  date.setHours(12, 0, 0, 0);
  return {
    date,
    name,
    rut,
    diagnosis: 'Test Diag',
    bedType: 'MEDIA',
    isUPC: false,
    status,
    sourceFile: 'test'
  };
};

export const runTests = () => {
  console.group('🏥 Medical Logic Tests');
  let passed = 0;
  let total = 0;

  const assert = (desc: string, actual: any, expected: any) => {
    total++;
    const isPass = actual === expected;
    if (isPass) {
      console.log(`✅ ${desc}`);
      passed++;
    } else {
      console.error(`❌ ${desc}`, { expected, actual });
    }
  };

  // TEST 1: Basic Length of Stay (Chilean Rule)
  // Present Day 1, 2, 3. Discharged Day 4.
  // Bed Days: 1, 2, 3 (Total 3). Day 4 excluded.
  const t1_snaps = [
    createSnapshot(1, 'John', '1-9'),
    createSnapshot(2, 'John', '1-9'),
    createSnapshot(3, 'John', '1-9'),
    createSnapshot(4, 'John', '1-9', 'DISCHARGED'),
  ];
  const t1_events = reconcileSnapshots(t1_snaps);
  assert('Event created', t1_events.length, 1);
  assert('Bed Days exclude discharge day', t1_events[0].los, 3);
  assert('Status is Alta', t1_events[0].status, 'Alta');

  // TEST 2: Implicit Discharge (Gap)
  // Present Day 1, 2. Missing Day 3, 4.
  // Should discharge on Day 3. Bed Days: 2.
  const t2_snaps = [
    createSnapshot(1, 'Jane', '2-9'),
    createSnapshot(2, 'Jane', '2-9'),
  ];
  const t2_events = reconcileSnapshots(t2_snaps);
  assert('Implicit discharge created', t2_events[0].status, 'Alta');
  assert('Discharge date is first missing day', t2_events[0].dischargeDate?.getDate(), 3);
  assert('Bed days correct for implicit', t2_events[0].los, 2);

  // TEST 3: Gap Tolerance (Weekend Skip)
  // Present Day 1 (Fri), Day 4 (Mon). Missing Sat, Sun.
  // Tolerance > 1 means 2 missing days (Sat, Sun) is acceptable?
  // Current logic: gapDays > 1 means 2 days gap is a BREAK. 
  // Wait, logic says: if (gapDays > 1) { isGap = true }. 
  // Day 1 to Day 4 diff is 3 days. gapDays = 2. 
  // So Day 1 -> Day 4 should be a break. 
  // Let's test Day 1 -> Day 3. Diff 2 days. gapDays = 1. Should be CONTINUOUS.
  const t3_snaps = [
    createSnapshot(1, 'Bob', '3-9'),
    createSnapshot(3, 'Bob', '3-9'),
  ];
  const t3_events = reconcileSnapshots(t3_snaps);
  assert('Tolerance handles 1 day gap', t3_events.length, 1);
  assert('Status continues', t3_events[0].status, 'Hospitalizado');

  // TEST 4: Resurrection
  // Day 1: Hosp
  // Day 2: Discharged (Clerical error)
  // Day 3: Hosp (Patient still there)
  // Should be 1 event.
  const t4_snaps = [
    createSnapshot(1, 'Zombie', '4-9'),
    createSnapshot(2, 'Zombie', '4-9', 'DISCHARGED'),
    createSnapshot(3, 'Zombie', '4-9', 'HOSPITALIZED'),
  ];
  const t4_events = reconcileSnapshots(t4_snaps);
  assert('Resurrection merges events', t4_events.length, 1);
  assert('Final status is Hospitalizado', t4_events[0].status, 'Hospitalizado');
  assert('Total stay calculated correctly', t4_events[0].los, 2); // Day 1, 2 (discharged but resurrected), Day 3 active. Wait.
  // Logic details: Day 1->2(Disch). Event closed. Day 3(Hosp). Gap is 1 day (Day 2 to 3).
  // IsGap? Day 2 to Day 3 diff is 1 day. gapDays = 0.
  // It continues. 
  // currentEvent.status was 'Alta'. Reverts to 'Hospitalizado'.
  // End result: Active on Day 3. So days are Day 1, 2. (Day 3 is lastSeen, if active, it counts if we measure up to now?)
  // LOS calculation depends on if it's currently hospitalized.
  // If active at global end (Day 3), LOS = Day 3 - Day 1 = 2 days? Or 3 days if inclusive?
  // Our logic: diff > 0 ? diff : 1. Day 3 - Day 1 = 2 days. Correct (Day 1, Day 2). Day 3 is today.

  console.log(`\n🏁 Result: ${passed}/${total} Passed`);
  console.groupEnd();
};
