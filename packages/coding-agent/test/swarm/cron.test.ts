/**
 * CronSchedule decides when a scheduled swarm turn fires. Every case passes explicit instants to nextAfter/matches, so
 * a run depends on its arguments alone; each calendar and DST boundary runs in a time zone fixed for its suite.
 */
import { afterAll, beforeAll, describe, expect, setSystemTime, test } from "bun:test";
import { CronSchedule } from "../../src/swarm/cron";
import { SwarmRefusal } from "../../src/swarm/types";

const STARTUP_ZONE = Intl.DateTimeFormat().resolvedOptions().timeZone;
const MINUTE_MS = 60_000;

/** Run the enclosing describe block in `zone`, then return the process to the zone it started in. */
function useTimeZone(zone: string): void {
	beforeAll(() => {
		process.env.TZ = zone;
	});
	afterAll(() => {
		process.env.TZ = STARTUP_ZONE;
	});
}

const iso = (text: string): string => new Date(text).toISOString();

function nextIso(expression: string, after: string): string {
	return new CronSchedule(expression).nextAfter(new Date(after)).toISOString();
}

function sequence(expression: string, after: string, count: number): string[] {
	const schedule = new CronSchedule(expression);
	const found: string[] = [];
	let cursor = new Date(after);
	for (let index = 0; index < count; index++) {
		cursor = schedule.nextAfter(cursor);
		found.push(cursor.toISOString());
	}
	return found;
}

interface NextRow {
	name: string;
	expression: string;
	after: string;
	next: string;
}

const NEXT_ROWS: NextRow[] = [
	{
		name: "steps of 3 minutes reach the next multiple",
		expression: "*/3 * * * *",
		after: "2026-03-01T10:00:00Z",
		next: "2026-03-01T10:03:00Z",
	},
	{
		name: "a minute that matches exactly at `after` is skipped (strictly after)",
		expression: "*/3 * * * *",
		after: "2026-03-01T10:03:00Z",
		next: "2026-03-01T10:06:00Z",
	},
	{
		name: "999 ms before a matching minute still reaches it",
		expression: "*/3 * * * *",
		after: "2026-03-01T10:02:59.999Z",
		next: "2026-03-01T10:03:00Z",
	},
	{
		name: "1 ms into a matching minute moves to the following match",
		expression: "*/3 * * * *",
		after: "2026-03-01T10:03:00.001Z",
		next: "2026-03-01T10:06:00Z",
	},
	{
		name: "steps wrap into the next hour",
		expression: "*/3 * * * *",
		after: "2026-03-01T10:57:30Z",
		next: "2026-03-01T11:00:00Z",
	},
	{
		name: "steps wrap into the next day",
		expression: "*/3 * * * *",
		after: "2026-03-01T23:58:00Z",
		next: "2026-03-02T00:00:00Z",
	},
	{
		name: "every minute advances one minute from the middle of a minute",
		expression: "* * * * *",
		after: "2026-03-01T10:03:30Z",
		next: "2026-03-01T10:04:00Z",
	},
	{
		name: "a daily midnight job runs at the next midnight",
		expression: "0 0 * * *",
		after: "2026-03-01T10:00:00Z",
		next: "2026-03-02T00:00:00Z",
	},
	{
		name: "a daily time one second ahead fires the same day",
		expression: "30 9 * * *",
		after: "2026-03-01T09:29:59Z",
		next: "2026-03-01T09:30:00Z",
	},
	{
		name: "a daily time on the minute fires the next day",
		expression: "30 9 * * *",
		after: "2026-03-01T09:30:00Z",
		next: "2026-03-02T09:30:00Z",
	},
	{
		name: "a minute list picks the next listed minute",
		expression: "15,45 * * * *",
		after: "2026-03-01T10:15:00Z",
		next: "2026-03-01T10:45:00Z",
	},
	{
		name: "a minute list wraps into the next hour",
		expression: "15,45 * * * *",
		after: "2026-03-01T10:45:01Z",
		next: "2026-03-01T11:15:00Z",
	},
	{
		name: "a stepped range takes its next member",
		expression: "10-20/5 * * * *",
		after: "2026-03-01T10:10:00Z",
		next: "2026-03-01T10:15:00Z",
	},
	{
		name: "a stepped range wraps after its last member",
		expression: "10-20/5 * * * *",
		after: "2026-03-01T10:20:00Z",
		next: "2026-03-01T11:10:00Z",
	},
	{
		name: "an hour range includes both bounds and wraps to the next day",
		expression: "0 9-17 * * *",
		after: "2026-03-01T17:00:00Z",
		next: "2026-03-02T09:00:00Z",
	},
	{
		name: "hour steps start at midnight",
		expression: "0 */6 * * *",
		after: "2026-03-01T06:00:00Z",
		next: "2026-03-01T12:00:00Z",
	},
	{
		name: "a value with a step runs to the end of the field",
		expression: "5/20 * * * *",
		after: "2026-03-01T10:05:00Z",
		next: "2026-03-01T10:25:00Z",
	},
	{
		name: "a monthly job rolls from January into February",
		expression: "0 0 1 * *",
		after: "2026-01-31T12:00:00Z",
		next: "2026-02-01T00:00:00Z",
	},
	{
		name: "a monthly job rolls from December into the next year",
		expression: "0 0 1 * *",
		after: "2026-12-15T00:00:00Z",
		next: "2027-01-01T00:00:00Z",
	},
	{
		name: "a yearly job later in the year waits for the next January",
		expression: "0 0 1 1 *",
		after: "2026-06-01T00:00:00Z",
		next: "2027-01-01T00:00:00Z",
	},
	{
		name: "the last minute of a year schedules the same minute a year on",
		expression: "59 23 31 12 *",
		after: "2026-12-31T23:59:00Z",
		next: "2027-12-31T23:59:00Z",
	},
	{
		name: "month names ignore letter case",
		expression: "0 0 1 jan,JUL *",
		after: "2026-02-01T00:00:00Z",
		next: "2026-07-01T00:00:00Z",
	},
	{
		name: "a weekday range by name skips the weekend",
		expression: "0 9 * * mon-fri",
		after: "2026-03-06T09:00:00Z",
		next: "2026-03-09T09:00:00Z",
	},
	...["0", "7", "sun", "SUN"].map(sunday => ({
		name: `day of week ${sunday} is Sunday`,
		expression: `0 0 * * ${sunday}`,
		after: "2026-03-01T00:00:00Z",
		next: "2026-03-08T00:00:00Z",
	})),
	{
		name: "only a restricted day of month leaves the weekday out",
		expression: "0 0 15 * *",
		after: "2026-03-01T00:00:00Z",
		next: "2026-03-15T00:00:00Z",
	},
	{
		name: "only a restricted weekday leaves the day of month out",
		expression: "0 0 * * 1",
		after: "2026-03-01T00:00:00Z",
		next: "2026-03-02T00:00:00Z",
	},
	{
		name: "restricted day of month and weekday match whichever comes first",
		expression: "0 0 15 * 1",
		after: "2026-03-10T00:00:00Z",
		next: "2026-03-15T00:00:00Z",
	},
	{
		name: "a starred day-of-month step still has to agree with the weekday",
		expression: "0 0 */2 * 1",
		after: "2026-03-01T00:00:00Z",
		next: "2026-03-09T00:00:00Z",
	},
	{
		name: "the 31st skips months that end earlier",
		expression: "0 0 31 * *",
		after: "2026-01-31T00:00:00Z",
		next: "2026-03-31T00:00:00Z",
	},
	{
		name: "the 30th passes over February",
		expression: "0 0 30 * *",
		after: "2026-01-30T00:00:00Z",
		next: "2026-03-30T00:00:00Z",
	},
	{
		name: "a leap day is reached two years ahead",
		expression: "0 0 29 2 *",
		after: "2026-01-01T00:00:00Z",
		next: "2028-02-29T00:00:00Z",
	},
	{
		name: "the leap day after a leap day is four years on",
		expression: "0 0 29 2 *",
		after: "2028-02-29T00:00:00Z",
		next: "2032-02-29T00:00:00Z",
	},
	{
		name: "the leap day after 2096 skips the common year 2100",
		expression: "0 0 29 2 *",
		after: "2096-03-01T00:00:00Z",
		next: "2104-02-29T00:00:00Z",
	},
	{
		name: "a leap day that must also be a Sunday is found in 2032",
		expression: "0 0 29 2 */7",
		after: "2026-01-01T00:00:00Z",
		next: "2032-02-29T00:00:00Z",
	},
	{
		name: "February 31st or a Monday matches the first Monday in February",
		expression: "0 0 31 2 1",
		after: "2026-01-01T00:00:00Z",
		next: "2026-02-02T00:00:00Z",
	},
];

interface SequenceRow {
	name: string;
	expression: string;
	after: string;
	next: string[];
}

const SEQUENCE_ROWS: SequenceRow[] = [
	{
		name: "*/3 keeps its three-minute grid",
		expression: "*/3 * * * *",
		after: "2026-03-01T10:00:00Z",
		next: ["10:03", "10:06", "10:09", "10:12"].map(time => `2026-03-01T${time}:00Z`),
	},
	{
		name: "a stepped range visits each member and then the next hour",
		expression: "10-20/5 * * * *",
		after: "2026-03-01T10:00:00Z",
		next: ["10:10", "10:15", "10:20", "11:10"].map(time => `2026-03-01T${time}:00Z`),
	},
	{
		name: "a value with a step lists minutes up to 59",
		expression: "5/20 * * * *",
		after: "2026-03-01T10:00:00Z",
		next: ["10:05", "10:25", "10:45", "11:05"].map(time => `2026-03-01T${time}:00Z`),
	},
	{
		name: "minute and hour lists combine into four daily times",
		expression: "0,30 */12 * * *",
		after: "2026-03-01T00:00:00Z",
		next: ["2026-03-01T00:30", "2026-03-01T12:00", "2026-03-01T12:30", "2026-03-02T00:00"].map(time => `${time}:00Z`),
	},
	{
		name: "day of month 15 or Monday alternate through March and April",
		expression: "0 0 15 * 1",
		after: "2026-03-01T00:00:00Z",
		next: [
			"2026-03-02",
			"2026-03-09",
			"2026-03-15",
			"2026-03-16",
			"2026-03-23",
			"2026-03-30",
			"2026-04-06",
			"2026-04-13",
			"2026-04-15",
		].map(day => `${day}T00:00:00Z`),
	},
	{
		name: "a starred day-of-month step intersects with Monday",
		expression: "0 0 */2 * 1",
		after: "2026-03-01T00:00:00Z",
		next: ["2026-03-09", "2026-03-23", "2026-04-13"].map(day => `${day}T00:00:00Z`),
	},
	{
		name: "weekday range 5-7 covers Friday, Saturday and Sunday",
		expression: "0 0 * * 5-7",
		after: "2026-03-03T00:00:00Z",
		next: ["2026-03-06", "2026-03-07", "2026-03-08", "2026-03-13"].map(day => `${day}T00:00:00Z`),
	},
	{
		name: "FRI-SUN closes its range on Sunday",
		expression: "0 0 * * FRI-SUN",
		after: "2026-03-03T00:00:00Z",
		next: ["2026-03-06", "2026-03-07", "2026-03-08", "2026-03-13"].map(day => `${day}T00:00:00Z`),
	},
	{
		name: "weekday range 0-7 covers every day",
		expression: "0 0 * * 0-7",
		after: "2026-03-03T00:00:00Z",
		next: ["2026-03-04", "2026-03-05"].map(day => `${day}T00:00:00Z`),
	},
	{
		name: "leap days recur every four years",
		expression: "0 0 29 2 *",
		after: "2026-01-01T00:00:00Z",
		next: ["2028-02-29", "2032-02-29", "2036-02-29"].map(day => `${day}T00:00:00Z`),
	},
];

interface InvalidRow {
	expression: string;
	reason: RegExp;
}

const INVALID_ROWS: InvalidRow[] = [
	{ expression: "", reason: /five fields.*found 0/ },
	{ expression: "   \t ", reason: /five fields.*found 0/ },
	{ expression: "* * * *", reason: /five fields.*found 4/ },
	{ expression: "* * * * * *", reason: /five fields.*found 6/ },
	{ expression: "@daily", reason: /five fields.*found 1/ },
	{ expression: "60 * * * *", reason: /minute "60" is outside 0-59/ },
	{ expression: "* 24 * * *", reason: /hour "24" is outside 0-23/ },
	{ expression: "* * 0 * *", reason: /day of month "0" is outside 1-31/ },
	{ expression: "* * 32 * *", reason: /day of month "32" is outside 1-31/ },
	{ expression: "* * * 0 *", reason: /month "0" is outside 1-12/ },
	{ expression: "* * * 13 *", reason: /month "13" is outside 1-12/ },
	{ expression: "* * * * 8", reason: /day of week "8" is outside 0-7/ },
	{ expression: "99999999999999999999 * * * *", reason: /outside 0-59/ },
	{ expression: "-1 * * * *", reason: /minute has an empty value/ },
	{ expression: "1.5 * * * *", reason: /"1.5" is not a valid minute/ },
	{ expression: "a * * * *", reason: /"a" is not a valid minute/ },
	{ expression: "? * * * *", reason: /"\?" is not a valid minute/ },
	{ expression: "* * * FOO *", reason: /"FOO" is not a valid month/ },
	{ expression: "* * * * FUNDAY", reason: /"FUNDAY" is not a valid day of week/ },
	{ expression: "JAN * * * *", reason: /"JAN" is not a valid minute/ },
	{ expression: "*/0 * * * *", reason: /step "0".*positive integer/ },
	{ expression: "*/-1 * * * *", reason: /step "-1".*positive integer/ },
	{ expression: "*/1.5 * * * *", reason: /step "1.5".*positive integer/ },
	{ expression: "*/ * * * *", reason: /step "".*positive integer/ },
	{ expression: `*/${"9".repeat(400)} * * * *`, reason: /step "9{400}".*positive integer/ },
	{ expression: `*/${Number.MAX_SAFE_INTEGER + 1} * * * *`, reason: /step "9007199254740992".*positive integer/ },
	{ expression: `5/${"9".repeat(400)} * * * *`, reason: /step "9{400}".*positive integer/ },
	{ expression: `${"9".repeat(400)} * * * *`, reason: /minute "9{400}" is outside 0-59/ },
	{ expression: "*/5/2 * * * *", reason: /more than one step/ },
	{ expression: "5-1 * * * *", reason: /range "5-1" runs backwards/ },
	{ expression: "* * * * 6-0", reason: /range "6-0" runs backwards/ },
	{ expression: "1-2-3 * * * *", reason: /not a value or a range/ },
	{ expression: "*-5 * * * *", reason: /"\*" is not a valid minute/ },
	{ expression: "1,,2 * * * *", reason: /minute has an empty value/ },
	{ expression: ",1 * * * *", reason: /minute has an empty value/ },
	{ expression: "1, * * * *", reason: /minute has an empty value/ },
	{ expression: "* * L * *", reason: /"L" is not a valid day of month/ },
];

const UNREACHABLE_EXPRESSIONS = [
	"0 0 31 2 *",
	"0 0 30 2 *",
	"0 0 30,31 2 *",
	"0 0 31 4 *",
	"0 0 31 4,6,9,11 *",
	"0 0 31 FEB *",
	"0 0 30 2 */2",
];

const REACHABLE_EXPRESSIONS = ["0 0 29 2 *", "0 0 29-31 2 *", "0 0 31 1,3,5,7,8,10,12 *", "0 0 30 1,2 *", "0 0 31 2 1"];

describe("CronSchedule in UTC", () => {
	useTimeZone("UTC");

	test("the suite runs in UTC", () => {
		expect(new Date(2026, 0, 15, 12).toISOString()).toBe("2026-01-15T12:00:00.000Z");
	});

	test.each(NEXT_ROWS)("nextAfter: $name", ({ expression, after, next }) => {
		expect(nextIso(expression, after)).toBe(iso(next));
	});

	test.each(SEQUENCE_ROWS)("successive nextAfter calls: $name", ({ expression, after, next }) => {
		expect(sequence(expression, after, next.length)).toEqual(next.map(iso));
	});

	test.each(INVALID_ROWS)("refuses $expression", ({ expression, reason }) => {
		expect(() => new CronSchedule(expression)).toThrow(SwarmRefusal);
		expect(() => new CronSchedule(expression)).toThrow(reason);
	});

	test.each(UNREACHABLE_EXPRESSIONS)("refuses %s because no calendar date matches", expression => {
		expect(() => new CronSchedule(expression)).toThrow(SwarmRefusal);
		expect(() => new CronSchedule(expression)).toThrow(/never matches/);
	});

	test.each(REACHABLE_EXPRESSIONS)("accepts %s because a calendar date matches", expression => {
		const schedule = new CronSchedule(expression);
		const found = schedule.nextAfter(new Date("2026-01-01T00:00:00Z"));
		expect(schedule.matches(found)).toBe(true);
	});

	test("refuses a constructor argument that is not a string", () => {
		expect(() => Reflect.construct(CronSchedule, [42])).toThrow(SwarmRefusal);
		expect(() => Reflect.construct(CronSchedule, [])).toThrow(SwarmRefusal);
	});

	test("normalizes whitespace in the exposed expression and behaves like the tidy form", () => {
		const untidy = new CronSchedule("  */3\t*  *\n*   * ");
		expect(untidy.expression).toBe("*/3 * * * *");
		expect(untidy.nextAfter(new Date("2026-03-01T10:00:00Z")).toISOString()).toBe(iso("2026-03-01T10:03:00Z"));
	});

	test("accepts a step as large as the largest safe integer; it selects only the first value", () => {
		const schedule = new CronSchedule(`*/${Number.MAX_SAFE_INTEGER} * * * *`);
		expect(schedule.nextAfter(new Date("2026-03-01T10:00:00Z")).toISOString()).toBe(iso("2026-03-01T11:00:00Z"));
		const fromFive = new CronSchedule(`5/${Number.MAX_SAFE_INTEGER} * * * *`);
		expect(fromFive.nextAfter(new Date("2026-03-01T10:05:00Z")).toISOString()).toBe(iso("2026-03-01T11:05:00Z"));
	});

	test("returns a whole-minute Date of its own and leaves the argument unchanged", () => {
		const schedule = new CronSchedule("*/3 * * * *");
		const after = new Date("2026-03-01T10:03:30.250Z");
		const before = after.getTime();
		const found = schedule.nextAfter(after);
		expect(found).not.toBe(after);
		expect(after.getTime()).toBe(before);
		expect(found.toISOString()).toBe(iso("2026-03-01T10:06:00Z"));
		expect([found.getSeconds(), found.getMilliseconds()]).toEqual([0, 0]);
		found.setTime(0);
		expect(schedule.nextAfter(after).toISOString()).toBe(iso("2026-03-01T10:06:00Z"));
	});

	test("depends on its arguments alone, never on the system clock", () => {
		const schedule = new CronSchedule("*/3 * * * *");
		try {
			setSystemTime(new Date("2031-05-05T05:05:05Z"));
			expect(schedule.nextAfter(new Date("2026-03-01T10:00:00Z")).toISOString()).toBe(iso("2026-03-01T10:03:00Z"));
			expect(schedule.matches(new Date("2026-03-01T10:03:00Z"))).toBe(true);
		} finally {
			setSystemTime();
		}
	});

	test("refuses invalid dates for nextAfter and matches", () => {
		const schedule = new CronSchedule("* * * * *");
		expect(() => schedule.nextAfter(new Date(Number.NaN))).toThrow(SwarmRefusal);
		expect(() => schedule.matches(new Date(Number.NaN))).toThrow(SwarmRefusal);
		expect(() => Reflect.apply(schedule.nextAfter, schedule, ["2026-03-01T10:00:00Z"])).toThrow(SwarmRefusal);
		expect(() => Reflect.apply(schedule.matches, schedule, [Date.now()])).toThrow(SwarmRefusal);
		expect(() => Reflect.apply(schedule.nextAfter, schedule, [])).toThrow(SwarmRefusal);
	});

	test("stops at the end of the Date range", () => {
		const schedule = new CronSchedule("* * * * *");
		expect(() => schedule.nextAfter(new Date(8.64e15))).toThrow(SwarmRefusal);
	});

	test("matches tests the local minute and ignores seconds", () => {
		const schedule = new CronSchedule("*/3 * * * *");
		const cases: Array<[string, boolean]> = [
			["2026-03-01T10:00:00Z", true],
			["2026-03-01T10:03:00Z", true],
			["2026-03-01T10:03:59.999Z", true],
			["2026-03-01T10:04:00Z", false],
			["2026-03-01T10:59:00Z", false],
			["2026-03-01T10:57:30Z", true],
		];
		for (const [at, expected] of cases) expect(schedule.matches(new Date(at)), at).toBe(expected);
	});

	test("matches applies the day-of-month and weekday rules", () => {
		const either = new CronSchedule("0 0 15 * 1");
		expect(either.matches(new Date("2026-03-15T00:00:00Z"))).toBe(true);
		expect(either.matches(new Date("2026-03-16T00:00:00Z"))).toBe(true);
		expect(either.matches(new Date("2026-03-17T00:00:00Z"))).toBe(false);
		const both = new CronSchedule("0 0 */2 * 1");
		expect(both.matches(new Date("2026-03-09T00:00:00Z"))).toBe(true);
		expect(both.matches(new Date("2026-03-02T00:00:00Z"))).toBe(false);
		expect(both.matches(new Date("2026-03-15T00:00:00Z"))).toBe(false);
		const named = new CronSchedule("0 0 1 JAN *");
		expect(named.matches(new Date("2027-01-01T00:00:00Z"))).toBe(true);
		expect(named.matches(new Date("2027-02-01T00:00:00Z"))).toBe(false);
	});

	test("every returned minute matches and no matching minute lies between consecutive results", () => {
		const schedule = new CronSchedule("7,19-23/2 */5 */9 * *");
		let cursor = new Date("2026-03-01T00:00:00Z");
		const missed: string[] = [];
		let ordered = true;
		let allMatch = true;
		for (let step = 0; step < 200; step++) {
			const found = schedule.nextAfter(cursor);
			ordered &&= found.getTime() > cursor.getTime();
			allMatch &&= schedule.matches(found);
			const firstProbe = Math.floor(cursor.getTime() / MINUTE_MS) * MINUTE_MS + MINUTE_MS;
			for (let probe = firstProbe; probe < found.getTime(); probe += MINUTE_MS) {
				if (schedule.matches(new Date(probe))) missed.push(new Date(probe).toISOString());
			}
			cursor = found;
		}
		expect(ordered).toBe(true);
		expect(allMatch).toBe(true);
		expect(missed).toEqual([]);
	});
});

interface ZoneDay {
	zone: string;
	year: number;
	month: number;
	day: number;
	/** Length of that local calendar day in hours. */
	hours: number;
}

const ZONE_DAYS: ZoneDay[] = [
	{ zone: "America/New_York", year: 2026, month: 3, day: 8, hours: 23 },
	{ zone: "America/New_York", year: 2026, month: 11, day: 1, hours: 25 },
	{ zone: "Europe/Berlin", year: 2026, month: 3, day: 29, hours: 23 },
	{ zone: "Europe/Berlin", year: 2026, month: 10, day: 25, hours: 25 },
	{ zone: "Australia/Lord_Howe", year: 2026, month: 4, day: 5, hours: 24.5 },
	{ zone: "Australia/Lord_Howe", year: 2026, month: 10, day: 4, hours: 23.5 },
];

/** Schedules whose ticks fall on a fixed grid of real minutes through any DST transition that shifts by whole grid steps. */
const GRID_SCHEDULES = [
	{ expression: "* * * * *", minutes: 1 },
	{ expression: "*/5 * * * *", minutes: 5 },
	{ expression: "*/15 * * * *", minutes: 15 },
	{ expression: "0 * * * *", minutes: 60 },
];

for (const row of ZONE_DAYS) {
	describe(`${row.zone} on ${row.year}-${row.month}-${row.day}`, () => {
		useTimeZone(row.zone);
		const start = () => new Date(row.year, row.month - 1, row.day);
		const end = () => new Date(row.year, row.month - 1, row.day + 1);
		// A shift of 30 minutes moves hourly wall-clock ticks off the real-time hour; every finer grid keeps its spacing.
		const grids = row.hours % 1 === 0 ? GRID_SCHEDULES : GRID_SCHEDULES.filter(grid => grid.minutes < 60);

		test("is a DST day of the expected length", () => {
			expect(end().getTime() - start().getTime()).toBe(row.hours * 3_600_000);
		});

		test.each(grids)(
			"$expression ticks every $minutes real minutes through the whole day",
			({ expression, minutes }) => {
				const schedule = new CronSchedule(expression);
				const ticks: number[] = [];
				// One millisecond before local midnight, so a tick exactly at midnight is the first result.
				let cursor = new Date(start().getTime() - 1);
				for (;;) {
					cursor = schedule.nextAfter(cursor);
					if (cursor.getTime() >= end().getTime()) break;
					ticks.push(cursor.getTime());
				}
				const spacing = minutes * 60_000;
				expect(ticks[0]).toBe(start().getTime());
				expect(ticks).toHaveLength((end().getTime() - start().getTime()) / spacing);
				for (let index = 1; index < ticks.length; index++) expect(ticks[index] - ticks[index - 1]).toBe(spacing);
			},
		);
	});
}

describe("America/New_York transitions", () => {
	useTimeZone("America/New_York");

	test("the suite runs in New York", () => {
		expect(new Date("2026-01-15T12:00:00Z").getTimezoneOffset()).toBe(300);
		expect(new Date("2026-07-15T12:00:00Z").getTimezoneOffset()).toBe(240);
	});

	test("a daily time inside the skipped spring hour fires on the next day that has it", () => {
		expect(nextIso("30 2 * * *", "2026-03-08T05:00:00Z")).toBe(iso("2026-03-09T06:30:00Z"));
	});

	test("the first local minute after the spring gap exists and fires", () => {
		expect(nextIso("0 3 * * *", "2026-03-08T05:00:00Z")).toBe(iso("2026-03-08T07:00:00Z"));
		expect(nextIso("0 12 * * *", "2026-03-07T17:00:00Z")).toBe(iso("2026-03-08T16:00:00Z"));
	});

	test("a three-minute grid continues across the spring gap", () => {
		expect(nextIso("*/3 * * * *", "2026-03-08T06:57:00Z")).toBe(iso("2026-03-08T07:00:00Z"));
	});

	test("a three-minute grid continues through the repeated autumn hour", () => {
		expect(nextIso("*/3 * * * *", "2026-11-01T05:57:00Z")).toBe(iso("2026-11-01T06:00:00Z"));
		expect(nextIso("*/3 * * * *", "2026-11-01T06:10:00Z")).toBe(iso("2026-11-01T06:12:00Z"));
	});

	test("a daily time inside the repeated autumn hour fires in both passes", () => {
		expect(sequence("30 1 * * *", "2026-11-01T04:00:00Z", 3)).toEqual([
			iso("2026-11-01T05:30:00Z"),
			iso("2026-11-01T06:30:00Z"),
			iso("2026-11-02T06:30:00Z"),
		]);
		const schedule = new CronSchedule("30 1 * * *");
		expect(schedule.matches(new Date("2026-11-01T05:30:00Z"))).toBe(true);
		expect(schedule.matches(new Date("2026-11-01T06:30:00Z"))).toBe(true);
		expect(schedule.matches(new Date("2026-11-01T07:30:00Z"))).toBe(false);
	});

	test("an hourly schedule ticks in both passes of the repeated hour", () => {
		expect(sequence("0 * * * *", "2026-11-01T04:30:00Z", 3)).toEqual([
			iso("2026-11-01T05:00:00Z"),
			iso("2026-11-01T06:00:00Z"),
			iso("2026-11-01T07:00:00Z"),
		]);
	});
});

describe("Australia/Lord_Howe half-hour transitions", () => {
	useTimeZone("Australia/Lord_Howe");

	test("the suite runs in Lord Howe", () => {
		expect(new Date("2026-01-15T12:00:00Z").getTimezoneOffset()).toBe(-660);
		expect(new Date("2026-07-15T12:00:00Z").getTimezoneOffset()).toBe(-630);
	});

	test("an hourly schedule jumps from 01:00 to 03:00 when the clock moves from 02:00 to 02:30", () => {
		expect(sequence("0 * * * *", "2026-10-03T13:29:00Z", 4)).toEqual([
			iso("2026-10-03T13:30:00Z"),
			iso("2026-10-03T14:30:00Z"),
			iso("2026-10-03T16:00:00Z"),
			iso("2026-10-03T17:00:00Z"),
		]);
	});

	test("an hourly schedule waits 90 real minutes from 01:00 to 02:00 when the clock moves back to 01:30", () => {
		expect(sequence("0 * * * *", "2026-04-04T13:30:00Z", 3)).toEqual([
			iso("2026-04-04T14:00:00Z"),
			iso("2026-04-04T15:30:00Z"),
			iso("2026-04-04T16:30:00Z"),
		]);
	});
});
