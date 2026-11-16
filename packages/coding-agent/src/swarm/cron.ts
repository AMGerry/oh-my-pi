import { SwarmRefusal } from "./types";

const MINUTE_MS = 60_000;
/** The Gregorian calendar repeats every 400 years: a date pattern absent from one cycle is absent for good. */
const CALENDAR_CYCLE_YEARS = 400;
const CYCLE_START_YEAR = 2000;

const MONTH_NAMES: Record<string, number> = {
	JAN: 1,
	FEB: 2,
	MAR: 3,
	APR: 4,
	MAY: 5,
	JUN: 6,
	JUL: 7,
	AUG: 8,
	SEP: 9,
	OCT: 10,
	NOV: 11,
	DEC: 12,
};
const WEEKDAY_NAMES: Record<string, number> = { SUN: 0, MON: 1, TUE: 2, WED: 3, THU: 4, FRI: 5, SAT: 6 };

interface FieldSpec {
	label: string;
	min: number;
	max: number;
	names?: Readonly<Record<string, number>>;
	/** Weekday numbering: 7 is a second spelling of Sunday (0), and a named Sunday that closes a range counts as 7. */
	weekday?: true;
}

const MINUTES: FieldSpec = { label: "minute", min: 0, max: 59 };
const HOURS: FieldSpec = { label: "hour", min: 0, max: 23 };
const MONTH_DAYS: FieldSpec = { label: "day of month", min: 1, max: 31 };
const MONTHS: FieldSpec = { label: "month", min: 1, max: 12, names: MONTH_NAMES };
const WEEKDAYS: FieldSpec = { label: "day of week", min: 0, max: 7, names: WEEKDAY_NAMES, weekday: true };

interface Field {
	/** Indexed by field value. */
	allowed: boolean[];
	/** The field text starts with `*`. */
	star: boolean;
}

function refuse(expression: string, reason: string): never {
	throw new SwarmRefusal(`Invalid cron expression "${expression}": ${reason}`);
}

function parseValue(token: string, spec: FieldSpec, expression: string): number {
	let value: number | undefined;
	if (/^\d+$/.test(token)) value = Number(token);
	else if (spec.names && /^[A-Za-z]{3}$/.test(token)) {
		const key = token.toUpperCase();
		if (Object.hasOwn(spec.names, key)) value = spec.names[key];
	}
	if (value === undefined)
		refuse(expression, token === "" ? `${spec.label} has an empty value` : `"${token}" is not a valid ${spec.label}`);
	if (value < spec.min || value > spec.max)
		refuse(expression, `${spec.label} "${token}" is outside ${spec.min}-${spec.max}`);
	return value;
}

/** One field: comma-separated wildcards, values or inclusive ranges with an optional `/step`. */
function parseField(text: string, spec: FieldSpec, expression: string): Field {
	const allowed = Array.from({ length: spec.max + 1 }, () => false);
	for (const item of text.split(",")) {
		const [rangeText, stepText, ...surplus] = item.split("/");
		if (surplus.length > 0) refuse(expression, `"${item}" has more than one step`);
		let low: number;
		let high: number;
		if (rangeText === "*") {
			low = spec.min;
			high = spec.max;
		} else {
			const [lowText, highText, ...extra] = rangeText.split("-");
			if (extra.length > 0) refuse(expression, `"${item}" is not a value or a range`);
			low = parseValue(lowText, spec, expression);
			if (highText === undefined) {
				// A bare value with a step runs to the end of the field: 5/15 in minutes is 5,20,35,50.
				high = stepText === undefined ? low : spec.max;
			} else {
				high = parseValue(highText, spec, expression);
				if (spec.weekday && high === 0 && low > 0 && !/^\d/.test(highText)) high = 7;
				if (low > high) refuse(expression, `range "${rangeText}" runs backwards`);
			}
		}
		let step = 1;
		if (stepText !== undefined) {
			// Digit strings beyond 2^53 or past 308 digits convert to inexact or infinite numbers, which cannot step.
			step = /^\d+$/.test(stepText) ? Number(stepText) : Number.NaN;
			if (!Number.isSafeInteger(step) || step < 1)
				refuse(expression, `step "${stepText}" in "${item}" must be a positive integer`);
		}
		for (let value = low; value <= high; value += step) allowed[value] = true;
	}
	if (spec.weekday && allowed[7]) allowed[0] = true;
	return { allowed, star: text.startsWith("*") };
}

function instantOf(value: unknown, operation: string): number {
	if (!(value instanceof Date) || Number.isNaN(value.getTime()))
		throw new SwarmRefusal(`${operation} needs a valid Date`);
	return value.getTime();
}

/** Local midnight of a calendar day; month and day overflow roll into the neighbouring period. */
function localMidnight(year: number, month: number, day: number): number {
	// Noon is a local time every zone has on every ordinary day, so the date change below lands on the intended day.
	const date = new Date(2000, 0, 1, 12);
	date.setFullYear(year, month, day);
	date.setHours(0, 0, 0, 0);
	return date.getTime();
}

/**
 * A five-field cron schedule (minute, hour, day of month, month, day of week) over local wall-clock time at minute
 * resolution.
 *
 * Each field takes numbers, `*`, comma lists, `low-high` ranges and `/step` (a positive integer). Months accept
 * JAN..DEC and weekdays SUN..SAT in any letter case; weekdays run 0-7 with both 0 and 7 meaning Sunday.
 *
 * The day fields follow Vixie cron: when either one starts with `*` a day must satisfy both fields, and when both are
 * restricted a day satisfying either one matches.
 *
 * Every real minute is tested by its local wall-clock fields. Local times that a spring-forward transition skips are
 * absent from that day, and local times that a fall-back transition repeats fire in both passes.
 */
export class CronSchedule {
	/** The expression with its whitespace normalized to single spaces. */
	readonly expression: string;
	readonly #minutes: boolean[];
	readonly #hours: boolean[];
	readonly #monthDays: boolean[];
	readonly #months: boolean[];
	readonly #weekdays: boolean[];
	readonly #dayFieldsIntersect: boolean;

	constructor(expression: string) {
		if (typeof expression !== "string") throw new SwarmRefusal("A cron expression must be a string");
		const fields = expression.trim().split(/\s+/).filter(Boolean);
		this.expression = fields.join(" ");
		if (fields.length !== 5)
			refuse(
				this.expression,
				`expected five fields (minute hour day-of-month month day-of-week) but found ${fields.length}`,
			);
		const minutes = parseField(fields[0], MINUTES, this.expression);
		const hours = parseField(fields[1], HOURS, this.expression);
		const monthDays = parseField(fields[2], MONTH_DAYS, this.expression);
		const months = parseField(fields[3], MONTHS, this.expression);
		const weekdays = parseField(fields[4], WEEKDAYS, this.expression);
		this.#minutes = minutes.allowed;
		this.#hours = hours.allowed;
		this.#monthDays = monthDays.allowed;
		this.#months = months.allowed;
		this.#weekdays = weekdays.allowed;
		this.#dayFieldsIntersect = monthDays.star || weekdays.star;
		this.#assertReachable();
	}

	/** Refuse day and month fields that name an impossible date, e.g. February 31st, by scanning one full calendar cycle. */
	#assertReachable(): void {
		for (let year = CYCLE_START_YEAR; year < CYCLE_START_YEAR + CALENDAR_CYCLE_YEARS; year++) {
			for (let month = 1; month <= 12; month++) {
				if (!this.#months[month]) continue;
				const firstWeekday = new Date(Date.UTC(year, month - 1, 1)).getUTCDay();
				const days = new Date(Date.UTC(year, month, 0)).getUTCDate();
				for (let day = 1; day <= days; day++) {
					if (this.#dayMatches(day, (firstWeekday + day - 1) % 7)) return;
				}
			}
		}
		throw new SwarmRefusal(
			`Cron expression "${this.expression}" never matches: its day and month fields name no calendar date`,
		);
	}

	#dayMatches(monthDay: number, weekday: number): boolean {
		const byMonthDay = this.#monthDays[monthDay];
		const byWeekday = this.#weekdays[weekday];
		return this.#dayFieldsIntersect ? byMonthDay && byWeekday : byMonthDay || byWeekday;
	}

	/** Whether the local minute containing `date` is scheduled; seconds and milliseconds are ignored. */
	matches(date: Date): boolean {
		instantOf(date, "matches");
		return (
			this.#minutes[date.getMinutes()] &&
			this.#hours[date.getHours()] &&
			this.#months[date.getMonth() + 1] &&
			this.#dayMatches(date.getDate(), date.getDay())
		);
	}

	/**
	 * The first scheduled minute strictly after `after`, as a new Date on a whole minute. Fields that do not match
	 * jump to the next month, day, hour or minute that can, so a distant date such as a leap day costs a few
	 * hundred steps.
	 */
	nextAfter(after: Date): Date {
		const origin = instantOf(after, "nextAfter");
		let time = origin - after.getSeconds() * 1000 - after.getMilliseconds() + MINUTE_MS;
		let lastYear: number | undefined;
		for (;;) {
			const at = new Date(time);
			const year = at.getFullYear();
			if (Number.isNaN(year))
				throw new SwarmRefusal(
					`Cron expression "${this.expression}" has no next time inside the supported date range`,
				);
			lastYear ??= year + CALENDAR_CYCLE_YEARS;
			if (year > lastYear)
				throw new SwarmRefusal(
					`Cron expression "${this.expression}" has no occurrence within ${CALENDAR_CYCLE_YEARS} years`,
				);
			const month = at.getMonth();
			const minute = at.getMinutes();
			let next: number;
			if (!this.#months[month + 1]) {
				const later = this.#months.findIndex((allowed, candidate) => allowed && candidate > month + 1);
				next =
					later === -1
						? localMidnight(year + 1, this.#months.indexOf(true) - 1, 1)
						: localMidnight(year, later - 1, 1);
			} else if (!this.#dayMatches(at.getDate(), at.getDay())) {
				next = localMidnight(year, month, at.getDate() + 1);
			} else if (!this.#hours[at.getHours()]) {
				// One hour boundary per step keeps every local hour visible across a DST transition.
				next = time + (60 - minute) * MINUTE_MS;
			} else if (!this.#minutes[minute]) {
				const later = this.#minutes.findIndex((allowed, candidate) => allowed && candidate > minute);
				next = time + ((later === -1 ? 60 : later) - minute) * MINUTE_MS;
			} else {
				return new Date(time);
			}
			time = Math.max(next, time + MINUTE_MS);
		}
	}
}
