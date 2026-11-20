// The functions sheets support and how many arguments each takes, kept apart from their
// implementations (functions.ts) so the parser checks names without loading the evaluator. Every
// name is an Excel function with the same meaning, so formulas export to .xlsx as written.
//
// Deliberately absent: HYPERLINK, WEBSERVICE, FILTERXML, IMPORT*, INDIRECT, OFFSET, CELL, INFO, RTD,
// CALL, REGISTER (they reach the network, other files or the host), and NOW and RAND (a value that
// changes on every read).

const MANY = 255;

/** Name to [least, most] arguments. A null-prototype object: "constructor" is not a key. */
export const FUNCTION_ARITY: Readonly<Record<string, readonly [number, number]>> = Object.freeze(
  Object.assign(Object.create(null) as Record<string, readonly [number, number]>, {
    SUM: [1, MANY],
    AVERAGE: [1, MANY],
    MIN: [1, MANY],
    MAX: [1, MANY],
    COUNT: [1, MANY],
    COUNTA: [1, MANY],
    COUNTBLANK: [1, 1],
    COUNTIF: [2, 2],
    COUNTIFS: [2, MANY - 1],
    SUMIF: [2, 3],
    SUMIFS: [3, MANY],
    AVERAGEIF: [2, 3],
    AVERAGEIFS: [3, MANY],
    PRODUCT: [1, MANY],
    MEDIAN: [1, MANY],
    STDEV: [1, MANY],
    ROUND: [2, 2],
    ROUNDUP: [2, 2],
    ROUNDDOWN: [2, 2],
    INT: [1, 1],
    ABS: [1, 1],
    MOD: [2, 2],
    POWER: [2, 2],
    SQRT: [1, 1],
    CEILING: [2, 2],
    FLOOR: [2, 2],
    IF: [2, 3],
    IFS: [2, MANY - 1],
    IFERROR: [2, 2],
    IFNA: [2, 2],
    AND: [1, MANY],
    OR: [1, MANY],
    NOT: [1, 1],
    XOR: [1, MANY],
    SWITCH: [3, MANY - 1],
    ISBLANK: [1, 1],
    ISNUMBER: [1, 1],
    ISTEXT: [1, 1],
    ISERROR: [1, 1],
    ISNA: [1, 1],
    CONCAT: [1, MANY],
    CONCATENATE: [1, MANY],
    TEXTJOIN: [3, MANY],
    LEN: [1, 1],
    LEFT: [1, 2],
    RIGHT: [1, 2],
    MID: [3, 3],
    UPPER: [1, 1],
    LOWER: [1, 1],
    PROPER: [1, 1],
    TRIM: [1, 1],
    SUBSTITUTE: [3, 4],
    REPT: [2, 2],
    FIND: [2, 3],
    SEARCH: [2, 3],
    VALUE: [1, 1],
    EXACT: [2, 2],
    VLOOKUP: [3, 4],
    HLOOKUP: [3, 4],
    XLOOKUP: [3, 6],
    INDEX: [2, 3],
    MATCH: [2, 3],
    DATE: [3, 3],
    YEAR: [1, 1],
    MONTH: [1, 1],
    DAY: [1, 1],
    WEEKDAY: [1, 2],
    EDATE: [2, 2],
    EOMONTH: [2, 2],
    DAYS: [2, 2],
    TODAY: [0, 0],
  }),
);

/** Every supported function, alphabetically: the list error messages and the skill quote. */
export const SHEET_FUNCTION_NAMES: readonly string[] = Object.keys(FUNCTION_ARITY).sort();

/**
 * Functions newer than Excel 2007's file format. In an .xlsx a formula writes them with the
 * `_xlfn.` prefix, or Excel shows #NAME?; an import strips it.
 */
export const XLFN_FUNCTIONS: ReadonlySet<string> = new Set([
  "CONCAT",
  "DAYS",
  "IFS",
  "SWITCH",
  "TEXTJOIN",
  "XLOOKUP",
  "XOR",
]);
