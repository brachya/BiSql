export type FunctionEngine = 'mssql' | 'mysql';

export interface SqlFunctionInfo {
    name: string;
    snippet: string;
    detail: string;
    documentation: string;
    example: string;
    engines: readonly FunctionEngine[];
}

const BOTH: readonly FunctionEngine[] = ['mssql', 'mysql'];
const MSSQL: readonly FunctionEngine[] = ['mssql'];
const MYSQL: readonly FunctionEngine[] = ['mysql'];

function f(
    engines: readonly FunctionEngine[],
    name: string,
    snippet: string,
    detail: string,
    documentation: string,
    example: string
): SqlFunctionInfo {
    return { name, snippet, detail, documentation, example, engines };
}

const COMMON: SqlFunctionInfo[] = [
    f(BOTH, 'COUNT', 'COUNT($0)', 'aggregate', 'Returns the number of items in a group.', 'COUNT(*) → 12'),
    f(BOTH, 'SUM', 'SUM($0)', 'aggregate', 'Returns the sum of all values, or only the DISTINCT values, in the expression.', 'SUM(amount) → 150.50'),
    f(BOTH, 'AVG', 'AVG($0)', 'aggregate', 'Returns the average of the values in a group.', 'AVG(score) → 87.5'),
    f(BOTH, 'MIN', 'MIN($0)', 'aggregate', 'Returns the minimum value in the expression.', 'MIN(price) → 9.99'),
    f(BOTH, 'MAX', 'MAX($0)', 'aggregate', 'Returns the maximum value in the expression.', 'MAX(price) → 199.00'),
    f(BOTH, 'COALESCE', 'COALESCE($0)', 'null handling', 'Evaluates arguments in order and returns the first non-null value.', "COALESCE(NULL, 'fallback') → 'fallback'"),
    f(BOTH, 'NULLIF', 'NULLIF(${1:expr1}, ${2:expr2})', 'null handling', 'Returns NULL if the two expressions are equal.', 'NULLIF(5, 5) → NULL'),
    f(BOTH, 'CAST', 'CAST(${1:expr} AS ${2:type})', 'conversion', 'Converts an expression of one data type to another.', "CAST('123' AS CHAR) → '123'"),
    f(BOTH, 'YEAR', 'YEAR($0)', 'date', 'Returns an integer that represents the year.', "YEAR('2026-08-20') → 2026"),
    f(BOTH, 'MONTH', 'MONTH($0)', 'date', 'Returns an integer that represents the month.', "MONTH('2026-08-20') → 8"),
    f(BOTH, 'DAY', 'DAY($0)', 'date', 'Returns an integer that represents the day of the month.', "DAY('2026-08-20') → 20"),
    f(BOTH, 'SUBSTRING', 'SUBSTRING(${1:expr}, ${2:start}, ${3:length})', 'string', 'Returns part of a string, starting at start for length characters.', "SUBSTRING('hello', 2, 3) → 'ell'"),
    f(BOTH, 'LEFT', 'LEFT(${1:expr}, ${2:length})', 'string', 'Returns the left part of a string with the specified number of characters.', "LEFT('hello', 2) → 'he'"),
    f(BOTH, 'RIGHT', 'RIGHT(${1:expr}, ${2:length})', 'string', 'Returns the right part of a string with the specified number of characters.', "RIGHT('hello', 2) → 'lo'"),
    f(BOTH, 'LTRIM', 'LTRIM($0)', 'string', 'Removes leading spaces.', "LTRIM('  hi') → 'hi'"),
    f(BOTH, 'RTRIM', 'RTRIM($0)', 'string', 'Removes trailing spaces.', "RTRIM('hi  ') → 'hi'"),
    f(BOTH, 'TRIM', 'TRIM($0)', 'string', 'Removes leading and trailing spaces.', "TRIM('  hi  ') → 'hi'"),
    f(BOTH, 'UPPER', 'UPPER($0)', 'string', 'Returns the string in uppercase.', "UPPER('asd') → 'ASD'"),
    f(BOTH, 'LOWER', 'LOWER($0)', 'string', 'Returns the string in lowercase.', "LOWER('ASD') → 'asd'"),
    f(BOTH, 'REPLACE', 'REPLACE(${1:expr}, ${2:pattern}, ${3:replacement})', 'string', 'Replaces all occurrences of a string with another string.', "REPLACE('foo bar', 'bar', 'baz') → 'foo baz'"),
    f(BOTH, 'CONCAT', 'CONCAT($0)', 'string', 'Concatenates string values and returns a string.', "CONCAT('Hello', ' ', 'World') → 'Hello World'"),
    f(BOTH, 'CONCAT_WS', 'CONCAT_WS(${1:sep}, $0)', 'string', 'Concatenates strings with a separator between them. Skips NULL values.', "CONCAT_WS(',', 'a', 'b') → 'a,b'"),
    f(BOTH, 'ABS', 'ABS($0)', 'math', 'Returns the absolute value.', 'ABS(-5) → 5'),
    f(BOTH, 'ROUND', 'ROUND(${1:expr}, ${2:decimals})', 'math', 'Returns a numeric value rounded to the specified number of decimals.', 'ROUND(1.567, 2) → 1.57'),
    f(BOTH, 'CEILING', 'CEILING($0)', 'math', 'Returns the smallest integer greater than or equal to the expression.', 'CEILING(1.2) → 2'),
    f(BOTH, 'FLOOR', 'FLOOR($0)', 'math', 'Returns the largest integer less than or equal to the expression.', 'FLOOR(1.8) → 1'),
    f(BOTH, 'POWER', 'POWER(${1:expr}, ${2:power})', 'math', 'Returns the value of the expression raised to the specified power.', 'POWER(2, 3) → 8'),
    f(BOTH, 'SQRT', 'SQRT($0)', 'math', 'Returns the square root.', 'SQRT(9) → 3'),
    f(BOTH, 'ROW_NUMBER', 'ROW_NUMBER() OVER (ORDER BY $0)', 'window', 'Numbers the output of a result set sequentially.', 'ROW_NUMBER() OVER (ORDER BY id) → 1, 2, 3, …'),
    f(BOTH, 'RANK', 'RANK() OVER (ORDER BY $0)', 'window', 'Returns the rank of each row within the partition of a result set.', 'RANK() OVER (ORDER BY score DESC) → 1, 2, 2, 4'),
    f(BOTH, 'DENSE_RANK', 'DENSE_RANK() OVER (ORDER BY $0)', 'window', 'Returns the rank without gaps in ranking values.', 'DENSE_RANK() OVER (ORDER BY score DESC) → 1, 2, 2, 3'),
    f(BOTH, 'LAG', 'LAG($0) OVER (ORDER BY ${1:col})', 'window', 'Accesses data from a previous row in the same result set.', 'LAG(amount) OVER (ORDER BY dt) → previous row value'),
    f(BOTH, 'LEAD', 'LEAD($0) OVER (ORDER BY ${1:col})', 'window', 'Accesses data from a subsequent row in the same result set.', 'LEAD(amount) OVER (ORDER BY dt) → next row value'),
    f(BOTH, 'FIRST_VALUE', 'FIRST_VALUE($0) OVER (ORDER BY ${1:col})', 'window', 'Returns the first value in the window frame.', 'FIRST_VALUE(amount) OVER (ORDER BY dt)'),
    f(BOTH, 'LAST_VALUE', 'LAST_VALUE($0) OVER (ORDER BY ${1:col})', 'window', 'Returns the last value in the window frame.', 'LAST_VALUE(amount) OVER (ORDER BY dt)'),
    f(BOTH, 'NTH_VALUE', 'NTH_VALUE(${1:expr}, ${2:n}) OVER (ORDER BY ${3:col})', 'window', 'Returns the Nth value in the window frame.', 'NTH_VALUE(amount, 2) OVER (ORDER BY dt)'),
    f(BOTH, 'NTILE', 'NTILE(${1:n}) OVER (ORDER BY $0)', 'window', 'Splits rows into n ranked groups.', 'NTILE(4) OVER (ORDER BY score)'),
    f(BOTH, 'CUME_DIST', 'CUME_DIST() OVER (ORDER BY $0)', 'window', 'Returns the cumulative distribution of a value.', 'CUME_DIST() OVER (ORDER BY score)'),
    f(BOTH, 'PERCENT_RANK', 'PERCENT_RANK() OVER (ORDER BY $0)', 'window', 'Returns the percent rank of a value.', 'PERCENT_RANK() OVER (ORDER BY score)')
];

const MSSQL_ONLY: SqlFunctionInfo[] = [
    f(MSSQL, 'ISNULL', 'ISNULL(${1:check}, ${2:replacement})', 'null handling', 'Replaces NULL with the specified replacement value.', "ISNULL(NULL, 'N/A') → 'N/A'"),
    f(MSSQL, 'CONVERT', 'CONVERT(${1:type}, ${2:expr})', 'conversion', 'Converts an expression of one data type to another, with optional style.', "CONVERT(INT, '123') → 123"),
    f(MSSQL, 'TRY_CAST', 'TRY_CAST(${1:expr} AS ${2:type})', 'conversion', 'Like CAST, but returns NULL on conversion failure.', "TRY_CAST('abc' AS INT) → NULL"),
    f(MSSQL, 'TRY_CONVERT', 'TRY_CONVERT(${1:type}, ${2:expr})', 'conversion', 'Like CONVERT, but returns NULL on conversion failure.', "TRY_CONVERT(INT, 'abc') → NULL"),
    f(MSSQL, 'GETDATE', 'GETDATE()', 'date', 'Returns the current database system timestamp.', "GETDATE() → '2026-08-20 14:52:00'"),
    f(MSSQL, 'GETUTCDATE', 'GETUTCDATE()', 'date', 'Returns the current UTC database system timestamp.', "GETUTCDATE() → '2026-08-20 11:52:00'"),
    f(MSSQL, 'SYSDATETIME', 'SYSDATETIME()', 'date', 'Returns the current database system datetime2(7).', "SYSDATETIME() → '2026-08-20 14:52:00.1234567'"),
    f(MSSQL, 'DATEADD', 'DATEADD(${1:datepart}, ${2:number}, ${3:date})', 'date', 'Adds a number of date parts (day, month, year, …) to a date.', "DATEADD(DAY, 1, '2026-01-01') → '2026-01-02'"),
    f(MSSQL, 'DATEDIFF', 'DATEDIFF(${1:datepart}, ${2:start}, ${3:end})', 'date', 'Returns the count of datepart boundaries crossed between two dates.', "DATEDIFF(DAY, '2026-01-01', '2026-01-10') → 9"),
    f(MSSQL, 'DATEPART', 'DATEPART(${1:datepart}, ${2:date})', 'date', 'Returns an integer for the specified datepart of a date.', "DATEPART(MONTH, '2026-08-20') → 8"),
    f(MSSQL, 'LEN', 'LEN($0)', 'string', 'Returns the number of characters in a string, excluding trailing blanks.', "LEN('hello') → 5"),
    f(MSSQL, 'CHARINDEX', 'CHARINDEX(${1:substr}, ${2:expr})', 'string', 'Searches for a substring and returns its starting position.', "CHARINDEX('l', 'hello') → 3"),
    f(MSSQL, 'FORMAT', 'FORMAT(${1:value}, ${2:format})', 'string', 'Returns a value formatted with the specified format and culture.', "FORMAT(1234.5, 'N2') → '1,234.50'"),
    f(MSSQL, 'IIF', 'IIF(${1:condition}, ${2:true}, ${3:false})', 'logical', 'Returns one of two values depending on a Boolean expression.', "IIF(1 > 0, 'yes', 'no') → 'yes'"),
    f(MSSQL, 'CHOOSE', 'CHOOSE(${1:index}, $0)', 'logical', 'Returns the item at the specified index from a list of values.', "CHOOSE(2, 'a', 'b', 'c') → 'b'"),
    f(MSSQL, 'NEWID', 'NEWID()', 'other', 'Creates a unique value of type uniqueidentifier.', "NEWID() → 'A0EEBC99-9C0B-4EF8-BB6D-6BB9BD380A11'"),
    f(MSSQL, 'SCOPE_IDENTITY', 'SCOPE_IDENTITY()', 'other', 'Returns the last identity value inserted into an identity column in the same scope.', 'SCOPE_IDENTITY() → 42')
];

const MYSQL_ONLY: SqlFunctionInfo[] = [
    f(MYSQL, 'GROUP_CONCAT', 'GROUP_CONCAT($0)', 'aggregate', 'Returns a concatenated string of non-NULL values from a group.', "GROUP_CONCAT(name) → 'a,b,c'"),
    f(MYSQL, 'ANY_VALUE', 'ANY_VALUE($0)', 'aggregate', 'Returns an arbitrary value from a group. Useful with ONLY_FULL_GROUP_BY.', 'ANY_VALUE(name)'),
    f(MYSQL, 'BIT_AND', 'BIT_AND($0)', 'aggregate', 'Bitwise AND of all bits in a group.', 'BIT_AND(flags)'),
    f(MYSQL, 'BIT_OR', 'BIT_OR($0)', 'aggregate', 'Bitwise OR of all bits in a group.', 'BIT_OR(flags)'),
    f(MYSQL, 'BIT_XOR', 'BIT_XOR($0)', 'aggregate', 'Bitwise XOR of all bits in a group.', 'BIT_XOR(flags)'),
    f(MYSQL, 'STD', 'STD($0)', 'aggregate', 'Population standard deviation (alias of STDDEV_POP).', 'STD(score)'),
    f(MYSQL, 'STDDEV', 'STDDEV($0)', 'aggregate', 'Population standard deviation (alias of STDDEV_POP).', 'STDDEV(score)'),
    f(MYSQL, 'STDDEV_POP', 'STDDEV_POP($0)', 'aggregate', 'Population standard deviation.', 'STDDEV_POP(score)'),
    f(MYSQL, 'STDDEV_SAMP', 'STDDEV_SAMP($0)', 'aggregate', 'Sample standard deviation.', 'STDDEV_SAMP(score)'),
    f(MYSQL, 'VARIANCE', 'VARIANCE($0)', 'aggregate', 'Population variance (alias of VAR_POP).', 'VARIANCE(score)'),
    f(MYSQL, 'VAR_POP', 'VAR_POP($0)', 'aggregate', 'Population standard variance.', 'VAR_POP(score)'),
    f(MYSQL, 'VAR_SAMP', 'VAR_SAMP($0)', 'aggregate', 'Sample standard variance.', 'VAR_SAMP(score)'),
    f(MYSQL, 'GROUPING', 'GROUPING($0)', 'aggregate', 'For GROUP BY WITH ROLLUP: 1 if the column is aggregated, else 0.', 'GROUPING(year)'),

    f(MYSQL, 'IF', 'IF(${1:condition}, ${2:true}, ${3:false})', 'logical', 'Returns one value if the condition is true, otherwise the other.', "IF(1 > 0, 'yes', 'no') → 'yes'"),
    f(MYSQL, 'IFNULL', 'IFNULL(${1:expr}, ${2:replacement})', 'null handling', 'Returns replacement if expr is NULL, otherwise expr. This is the MySQL equivalent of SQL Server ISNULL.', "IFNULL(NULL, 'N/A') → 'N/A'"),
    f(MYSQL, 'ISNULL', 'ISNULL($0)', 'null handling', 'Returns 1 if the expression is NULL, otherwise 0. Not the same as SQL Server ISNULL(a, b).', 'ISNULL(NULL) → 1'),
    f(MYSQL, 'GREATEST', 'GREATEST($0)', 'comparison', 'Returns the largest argument.', "GREATEST(1, 4, 2) → 4"),
    f(MYSQL, 'LEAST', 'LEAST($0)', 'comparison', 'Returns the smallest argument.', 'LEAST(1, 4, 2) → 1'),
    f(MYSQL, 'INTERVAL', 'INTERVAL(${1:n}, ${2:n1}, ${3:n2})', 'comparison', 'Returns 0 if n < n1, 1 if n < n2, and so on. This is a compare function, not the INTERVAL 1 DAY date syntax.', 'INTERVAL(5, 1, 3, 8) → 2'),

    f(MYSQL, 'CONVERT', 'CONVERT(${1:expr}, ${2:type})', 'conversion', 'Converts expr to another type, or CONVERT(expr USING charset) to change character set.', "CONVERT('123', SIGNED) → 123"),
    f(MYSQL, 'CONV', 'CONV(${1:n}, ${2:from_base}, ${3:to_base})', 'conversion', 'Converts a number between bases.', "CONV('A', 16, 10) → '10'"),
    f(MYSQL, 'FORMAT', 'FORMAT(${1:number}, ${2:decimals})', 'string', 'Formats a number with commas and the given decimal places.', "FORMAT(1234.5, 2) → '1,234.50'"),

    f(MYSQL, 'NOW', 'NOW()', 'date', 'Returns the current date and time.', "NOW() → '2026-08-23 11:06:00'"),
    f(MYSQL, 'CURDATE', 'CURDATE()', 'date', 'Returns the current date.', "CURDATE() → '2026-08-23'"),
    f(MYSQL, 'CURTIME', 'CURTIME()', 'date', 'Returns the current time.', "CURTIME() → '11:06:00'"),
    f(MYSQL, 'CURRENT_DATE', 'CURRENT_DATE()', 'date', 'Returns the current date (alias of CURDATE).', "CURRENT_DATE() → '2026-08-23'"),
    f(MYSQL, 'CURRENT_TIME', 'CURRENT_TIME()', 'date', 'Returns the current time (alias of CURTIME).', "CURRENT_TIME() → '11:06:00'"),
    f(MYSQL, 'CURRENT_TIMESTAMP', 'CURRENT_TIMESTAMP()', 'date', 'Returns the current date and time (alias of NOW).', "CURRENT_TIMESTAMP() → '2026-08-23 11:06:00'"),
    f(MYSQL, 'LOCALTIME', 'LOCALTIME()', 'date', 'Returns the current date and time (alias of NOW).', 'LOCALTIME()'),
    f(MYSQL, 'LOCALTIMESTAMP', 'LOCALTIMESTAMP()', 'date', 'Returns the current date and time (alias of NOW).', 'LOCALTIMESTAMP()'),
    f(MYSQL, 'SYSDATE', 'SYSDATE()', 'date', 'Returns the time at which the function runs (not statement start).', 'SYSDATE()'),
    f(MYSQL, 'UTC_DATE', 'UTC_DATE()', 'date', 'Returns the current UTC date.', 'UTC_DATE()'),
    f(MYSQL, 'UTC_TIME', 'UTC_TIME()', 'date', 'Returns the current UTC time.', 'UTC_TIME()'),
    f(MYSQL, 'UTC_TIMESTAMP', 'UTC_TIMESTAMP()', 'date', 'Returns the current UTC date and time.', 'UTC_TIMESTAMP()'),
    f(MYSQL, 'DATE', 'DATE($0)', 'date', 'Extracts the date part of a datetime.', "DATE('2026-08-23 11:06:00') → '2026-08-23'"),
    f(MYSQL, 'TIME', 'TIME($0)', 'date', 'Extracts the time part of a datetime.', "TIME('2026-08-23 11:06:00') → '11:06:00'"),
    f(MYSQL, 'TIMESTAMP', 'TIMESTAMP($0)', 'date', 'Returns a datetime from a date or date plus time.', "TIMESTAMP('2026-08-23')"),
    f(MYSQL, 'DATE_ADD', 'DATE_ADD(${1:date}, INTERVAL ${2:1} ${3:DAY})', 'date', 'Adds a time interval to a date. Use INTERVAL n UNIT, not DATEADD.', "DATE_ADD('2026-01-01', INTERVAL 1 DAY) → '2026-01-02'"),
    f(MYSQL, 'DATE_SUB', 'DATE_SUB(${1:date}, INTERVAL ${2:1} ${3:DAY})', 'date', 'Subtracts a time interval from a date.', "DATE_SUB('2026-01-02', INTERVAL 1 DAY) → '2026-01-01'"),
    f(MYSQL, 'ADDDATE', 'ADDDATE(${1:date}, INTERVAL ${2:1} ${3:DAY})', 'date', 'Alias of DATE_ADD. Can also take a day count as the second argument.', "ADDDATE('2026-01-01', 1) → '2026-01-02'"),
    f(MYSQL, 'SUBDATE', 'SUBDATE(${1:date}, INTERVAL ${2:1} ${3:DAY})', 'date', 'Alias of DATE_SUB. Can also take a day count as the second argument.', "SUBDATE('2026-01-02', 1) → '2026-01-01'"),
    f(MYSQL, 'ADDTIME', 'ADDTIME(${1:expr}, ${2:time})', 'date', 'Adds a time value to a time or datetime.', "ADDTIME('11:00:00', '00:10:00') → '11:10:00'"),
    f(MYSQL, 'SUBTIME', 'SUBTIME(${1:expr}, ${2:time})', 'date', 'Subtracts a time value from a time or datetime.', "SUBTIME('11:10:00', '00:10:00') → '11:00:00'"),
    f(MYSQL, 'DATEDIFF', 'DATEDIFF(${1:end}, ${2:start})', 'date', 'Returns the number of days between two dates (end − start). Not the SQL Server DATEPART form.', "DATEDIFF('2026-01-10', '2026-01-01') → 9"),
    f(MYSQL, 'TIMEDIFF', 'TIMEDIFF(${1:end}, ${2:start})', 'date', 'Returns the time difference between two time or datetime values.', "TIMEDIFF('12:00:00', '11:00:00') → '01:00:00'"),
    f(MYSQL, 'TIMESTAMPADD', 'TIMESTAMPADD(${1:unit}, ${2:n}, ${3:datetime})', 'date', 'Adds n units to a datetime.', "TIMESTAMPADD(DAY, 1, '2026-01-01') → '2026-01-02'"),
    f(MYSQL, 'TIMESTAMPDIFF', 'TIMESTAMPDIFF(${1:unit}, ${2:start}, ${3:end})', 'date', 'Returns the integer difference in the given unit between two datetimes.', "TIMESTAMPDIFF(HOUR, '2026-01-01', '2026-01-02') → 24"),
    f(MYSQL, 'DATE_FORMAT', 'DATE_FORMAT(${1:date}, ${2:format})', 'date', 'Formats a date with a format string (%Y, %m, %d, …).', "DATE_FORMAT('2026-08-23', '%Y-%m') → '2026-08'"),
    f(MYSQL, 'TIME_FORMAT', 'TIME_FORMAT(${1:time}, ${2:format})', 'date', 'Formats a time with a format string.', "TIME_FORMAT('11:06:00', '%H:%i') → '11:06'"),
    f(MYSQL, 'STR_TO_DATE', 'STR_TO_DATE(${1:str}, ${2:format})', 'date', 'Parses a string into a date using a format string.', "STR_TO_DATE('23/08/2026', '%d/%m/%Y') → '2026-08-23'"),
    f(MYSQL, 'GET_FORMAT', 'GET_FORMAT(${1:DATE}, ${2:ISO})', 'date', 'Returns a format string for DATE, TIME, or DATETIME.', "GET_FORMAT(DATE, 'ISO') → '%Y-%m-%d'"),
    f(MYSQL, 'FROM_UNIXTIME', 'FROM_UNIXTIME($0)', 'date', 'Converts a Unix timestamp to a datetime.', "FROM_UNIXTIME(0) → '1970-01-01 00:00:00'"),
    f(MYSQL, 'UNIX_TIMESTAMP', 'UNIX_TIMESTAMP($0)', 'date', 'Returns a Unix timestamp. No argument means now.', "UNIX_TIMESTAMP('2026-01-01')"),
    f(MYSQL, 'FROM_DAYS', 'FROM_DAYS($0)', 'date', 'Converts a day number to a date.', "FROM_DAYS(739000)"),
    f(MYSQL, 'TO_DAYS', 'TO_DAYS($0)', 'date', 'Converts a date to a day number.', "TO_DAYS('2026-08-23')"),
    f(MYSQL, 'TO_SECONDS', 'TO_SECONDS($0)', 'date', 'Converts a date or datetime to seconds since year 0.', "TO_SECONDS('2026-08-23')"),
    f(MYSQL, 'SEC_TO_TIME', 'SEC_TO_TIME($0)', 'date', 'Converts seconds to a time value.', "SEC_TO_TIME(3661) → '01:01:01'"),
    f(MYSQL, 'TIME_TO_SEC', 'TIME_TO_SEC($0)', 'date', 'Converts a time to seconds.', "TIME_TO_SEC('01:01:01') → 3661"),
    f(MYSQL, 'CONVERT_TZ', 'CONVERT_TZ(${1:dt}, ${2:from_tz}, ${3:to_tz})', 'date', 'Converts a datetime from one time zone to another.', "CONVERT_TZ('2026-01-01 12:00:00', 'UTC', 'Asia/Jerusalem')"),
    f(MYSQL, 'EXTRACT', 'EXTRACT(${1:YEAR} FROM $0)', 'date', 'Extracts a part from a date or time.', "EXTRACT(YEAR FROM '2026-08-23') → 2026"),
    f(MYSQL, 'LAST_DAY', 'LAST_DAY($0)', 'date', 'Returns the last day of the month for a date.', "LAST_DAY('2026-02-01') → '2026-02-28'"),
    f(MYSQL, 'MAKEDATE', 'MAKEDATE(${1:year}, ${2:dayofyear})', 'date', 'Returns a date from a year and day-of-year.', "MAKEDATE(2026, 32) → '2026-02-01'"),
    f(MYSQL, 'MAKETIME', 'MAKETIME(${1:hour}, ${2:minute}, ${3:second})', 'date', 'Returns a time from hour, minute, and second.', "MAKETIME(11, 6, 0) → '11:06:00'"),
    f(MYSQL, 'PERIOD_ADD', 'PERIOD_ADD(${1:period}, ${2:n})', 'date', 'Adds n months to a period in YYYYMM form.', 'PERIOD_ADD(202601, 2) → 202603'),
    f(MYSQL, 'PERIOD_DIFF', 'PERIOD_DIFF(${1:p1}, ${2:p2})', 'date', 'Returns the number of months between two YYYYMM periods.', 'PERIOD_DIFF(202603, 202601) → 2'),
    f(MYSQL, 'DAYNAME', 'DAYNAME($0)', 'date', 'Returns the weekday name.', "DAYNAME('2026-08-23') → 'Sunday'"),
    f(MYSQL, 'DAYOFMONTH', 'DAYOFMONTH($0)', 'date', 'Returns the day of the month (alias of DAY).', "DAYOFMONTH('2026-08-23') → 23"),
    f(MYSQL, 'DAYOFWEEK', 'DAYOFWEEK($0)', 'date', 'Returns the weekday index (1 = Sunday).', "DAYOFWEEK('2026-08-23') → 1"),
    f(MYSQL, 'DAYOFYEAR', 'DAYOFYEAR($0)', 'date', 'Returns the day of the year (1–366).', "DAYOFYEAR('2026-08-23') → 235"),
    f(MYSQL, 'MONTHNAME', 'MONTHNAME($0)', 'date', 'Returns the month name.', "MONTHNAME('2026-08-23') → 'August'"),
    f(MYSQL, 'QUARTER', 'QUARTER($0)', 'date', 'Returns the quarter (1–4).', "QUARTER('2026-08-23') → 3"),
    f(MYSQL, 'WEEK', 'WEEK($0)', 'date', 'Returns the week number. Optional mode sets the first day of the week.', "WEEK('2026-08-23')"),
    f(MYSQL, 'WEEKDAY', 'WEEKDAY($0)', 'date', 'Returns the weekday index (0 = Monday).', "WEEKDAY('2026-08-23') → 6"),
    f(MYSQL, 'WEEKOFYEAR', 'WEEKOFYEAR($0)', 'date', 'Returns the ISO week of the year.', "WEEKOFYEAR('2026-08-23')"),
    f(MYSQL, 'YEARWEEK', 'YEARWEEK($0)', 'date', 'Returns year and week as one number.', "YEARWEEK('2026-08-23')"),
    f(MYSQL, 'HOUR', 'HOUR($0)', 'date', 'Returns the hour (0–23, or more for time values).', "HOUR('11:06:00') → 11"),
    f(MYSQL, 'MINUTE', 'MINUTE($0)', 'date', 'Returns the minute (0–59).', "MINUTE('11:06:00') → 6"),
    f(MYSQL, 'SECOND', 'SECOND($0)', 'date', 'Returns the second (0–59).', "SECOND('11:06:00') → 0"),
    f(MYSQL, 'MICROSECOND', 'MICROSECOND($0)', 'date', 'Returns the microseconds.', "MICROSECOND('11:06:00.123456') → 123456"),

    f(MYSQL, 'SUBSTRING_INDEX', 'SUBSTRING_INDEX(${1:str}, ${2:delim}, ${3:count})', 'string', 'Returns a substring before count occurrences of a delimiter. Negative count counts from the right.', "SUBSTRING_INDEX('a.b.c', '.', 2) → 'a.b'"),
    f(MYSQL, 'SUBSTR', 'SUBSTR(${1:expr}, ${2:start}, ${3:length})', 'string', 'Alias of SUBSTRING.', "SUBSTR('hello', 2, 3) → 'ell'"),
    f(MYSQL, 'MID', 'MID(${1:expr}, ${2:start}, ${3:length})', 'string', 'Alias of SUBSTRING.', "MID('hello', 2, 3) → 'ell'"),
    f(MYSQL, 'LENGTH', 'LENGTH($0)', 'string', 'Returns the length in bytes. Use CHAR_LENGTH for characters.', "LENGTH('hello') → 5"),
    f(MYSQL, 'CHAR_LENGTH', 'CHAR_LENGTH($0)', 'string', 'Returns the length in characters.', "CHAR_LENGTH('hello') → 5"),
    f(MYSQL, 'CHARACTER_LENGTH', 'CHARACTER_LENGTH($0)', 'string', 'Alias of CHAR_LENGTH.', "CHARACTER_LENGTH('hello') → 5"),
    f(MYSQL, 'OCTET_LENGTH', 'OCTET_LENGTH($0)', 'string', 'Alias of LENGTH (bytes).', "OCTET_LENGTH('hello') → 5"),
    f(MYSQL, 'BIT_LENGTH', 'BIT_LENGTH($0)', 'string', 'Returns the length in bits.', "BIT_LENGTH('a') → 8"),
    f(MYSQL, 'LCASE', 'LCASE($0)', 'string', 'Alias of LOWER.', "LCASE('ASD') → 'asd'"),
    f(MYSQL, 'UCASE', 'UCASE($0)', 'string', 'Alias of UPPER.', "UCASE('asd') → 'ASD'"),
    f(MYSQL, 'LPAD', 'LPAD(${1:str}, ${2:len}, ${3:pad})', 'string', 'Pads the string on the left to the given length.', "LPAD('7', 3, '0') → '007'"),
    f(MYSQL, 'RPAD', 'RPAD(${1:str}, ${2:len}, ${3:pad})', 'string', 'Pads the string on the right to the given length.', "RPAD('7', 3, '0') → '700'"),
    f(MYSQL, 'LOCATE', 'LOCATE(${1:substr}, ${2:str})', 'string', 'Returns the position of the first occurrence of a substring (1-based), or 0.', "LOCATE('l', 'hello') → 3"),
    f(MYSQL, 'INSTR', 'INSTR(${1:str}, ${2:substr})', 'string', 'Like LOCATE, but the string comes first.', "INSTR('hello', 'l') → 3"),
    f(MYSQL, 'POSITION', 'POSITION(${1:substr} IN ${2:str})', 'string', 'Alias of LOCATE, using IN syntax.', "POSITION('l' IN 'hello') → 3"),
    f(MYSQL, 'FIELD', 'FIELD(${1:str}, $0)', 'string', 'Returns the index (1-based) of str in the following arguments, or 0.', "FIELD('b', 'a', 'b', 'c') → 2"),
    f(MYSQL, 'FIND_IN_SET', 'FIND_IN_SET(${1:str}, ${2:list})', 'string', 'Returns the index of str in a comma-separated list, or 0.', "FIND_IN_SET('b', 'a,b,c') → 2"),
    f(MYSQL, 'ELT', 'ELT(${1:n}, $0)', 'string', 'Returns the Nth string argument.', "ELT(2, 'a', 'b', 'c') → 'b'"),
    f(MYSQL, 'INSERT', 'INSERT(${1:str}, ${2:pos}, ${3:len}, ${4:newstr})', 'string', 'Replaces a slice of a string. This is a string function, not INSERT INTO.', "INSERT('hello', 2, 3, 'y') → 'hyo'"),
    f(MYSQL, 'REPEAT', 'REPEAT(${1:str}, ${2:count})', 'string', 'Repeats a string count times.', "REPEAT('ab', 3) → 'ababab'"),
    f(MYSQL, 'REVERSE', 'REVERSE($0)', 'string', 'Reverses a string.', "REVERSE('abc') → 'cba'"),
    f(MYSQL, 'SPACE', 'SPACE($0)', 'string', 'Returns a string of N spaces.', "SPACE(3) → '   '"),
    f(MYSQL, 'CHAR', 'CHAR($0)', 'string', 'Returns a string from integer code points.', "CHAR(77, 121) → 'My'"),
    f(MYSQL, 'ASCII', 'ASCII($0)', 'string', 'Returns the numeric value of the leftmost character.', "ASCII('A') → 65"),
    f(MYSQL, 'ORD', 'ORD($0)', 'string', 'Returns the code of the leftmost character, including multibyte.', "ORD('A') → 65"),
    f(MYSQL, 'HEX', 'HEX($0)', 'string', 'Returns a hexadecimal string for a number or string.', "HEX('abc') → '616263'"),
    f(MYSQL, 'UNHEX', 'UNHEX($0)', 'string', 'Converts a hex string back to bytes.', "UNHEX('616263') → 'abc'"),
    f(MYSQL, 'BIN', 'BIN($0)', 'string', 'Returns a binary string for a number.', "BIN(5) → '101'"),
    f(MYSQL, 'OCT', 'OCT($0)', 'string', 'Returns an octal string for a number.', "OCT(8) → '10'"),
    f(MYSQL, 'QUOTE', 'QUOTE($0)', 'string', 'Quotes a string so it can be used as a data value in SQL.', "QUOTE('a\\'b')"),
    f(MYSQL, 'SOUNDEX', 'SOUNDEX($0)', 'string', 'Returns a soundex string.', "SOUNDEX('hello')"),
    f(MYSQL, 'STRCMP', 'STRCMP(${1:a}, ${2:b})', 'string', 'Returns -1, 0, or 1 when comparing two strings.', "STRCMP('a', 'b') → -1"),
    f(MYSQL, 'MAKE_SET', 'MAKE_SET(${1:bits}, $0)', 'string', 'Returns a comma-separated set of strings for the bits that are set.', "MAKE_SET(1|4, 'a', 'b', 'c') → 'a,c'"),
    f(MYSQL, 'EXPORT_SET', 'EXPORT_SET(${1:bits}, ${2:on}, ${3:off})', 'string', 'Returns a string for each bit, using on/off labels.', "EXPORT_SET(5, 'Y', 'N', ',', 4) → 'Y,N,Y,N'"),
    f(MYSQL, 'WEIGHT_STRING', 'WEIGHT_STRING($0)', 'string', 'Returns the weight string used for collation comparisons.', 'WEIGHT_STRING(name)'),
    f(MYSQL, 'TO_BASE64', 'TO_BASE64($0)', 'string', 'Encodes a string as Base64.', "TO_BASE64('abc')"),
    f(MYSQL, 'FROM_BASE64', 'FROM_BASE64($0)', 'string', 'Decodes a Base64 string.', 'FROM_BASE64(data)'),
    f(MYSQL, 'COMPRESS', 'COMPRESS($0)', 'string', 'Compresses a string (binary result).', 'COMPRESS(blob)'),
    f(MYSQL, 'UNCOMPRESS', 'UNCOMPRESS($0)', 'string', 'Uncompresses a string produced by COMPRESS.', 'UNCOMPRESS(blob)'),
    f(MYSQL, 'UNCOMPRESSED_LENGTH', 'UNCOMPRESSED_LENGTH($0)', 'string', 'Returns the length of a COMPRESS value before compression.', 'UNCOMPRESSED_LENGTH(blob)'),
    f(MYSQL, 'LOAD_FILE', 'LOAD_FILE($0)', 'string', 'Reads a file on the server and returns the contents. Needs FILE privilege.', "LOAD_FILE('/tmp/data.txt')"),
    f(MYSQL, 'REGEXP_LIKE', 'REGEXP_LIKE(${1:expr}, ${2:pattern})', 'string', 'Returns 1 if expr matches the regular expression.', "REGEXP_LIKE('abc', '^a') → 1"),
    f(MYSQL, 'REGEXP_INSTR', 'REGEXP_INSTR(${1:expr}, ${2:pattern})', 'string', 'Returns the position of a regexp match, or 0.', "REGEXP_INSTR('abc123', '[0-9]') → 4"),
    f(MYSQL, 'REGEXP_REPLACE', 'REGEXP_REPLACE(${1:expr}, ${2:pattern}, ${3:repl})', 'string', 'Replaces regexp matches.', "REGEXP_REPLACE('a1b2', '[0-9]', 'X') → 'aXbX'"),
    f(MYSQL, 'REGEXP_SUBSTR', 'REGEXP_SUBSTR(${1:expr}, ${2:pattern})', 'string', 'Returns the substring that matches a regexp.', "REGEXP_SUBSTR('abc123', '[0-9]+') → '123'"),

    f(MYSQL, 'CEIL', 'CEIL($0)', 'math', 'Alias of CEILING.', 'CEIL(1.2) → 2'),
    f(MYSQL, 'POW', 'POW(${1:expr}, ${2:power})', 'math', 'Alias of POWER.', 'POW(2, 3) → 8'),
    f(MYSQL, 'MOD', 'MOD(${1:n}, ${2:m})', 'math', 'Returns the remainder of n divided by m.', 'MOD(10, 3) → 1'),
    f(MYSQL, 'TRUNCATE', 'TRUNCATE(${1:n}, ${2:decimals})', 'math', 'Truncates a number to the given decimals (does not round).', 'TRUNCATE(1.567, 2) → 1.56'),
    f(MYSQL, 'RAND', 'RAND()', 'math', 'Returns a random float from 0 to 1. Optional seed.', 'RAND()'),
    f(MYSQL, 'PI', 'PI()', 'math', 'Returns the value of π.', 'PI() → 3.141593'),
    f(MYSQL, 'SIGN', 'SIGN($0)', 'math', 'Returns -1, 0, or 1 for the sign of a number.', 'SIGN(-4) → -1'),
    f(MYSQL, 'EXP', 'EXP($0)', 'math', 'Returns e raised to the given power.', 'EXP(1) → 2.718282'),
    f(MYSQL, 'LN', 'LN($0)', 'math', 'Returns the natural logarithm.', 'LN(2.718282) → 1'),
    f(MYSQL, 'LOG', 'LOG($0)', 'math', 'Natural log, or LOG(base, n) for a given base.', 'LOG(100) / LOG(10) → 2'),
    f(MYSQL, 'LOG10', 'LOG10($0)', 'math', 'Returns the base-10 logarithm.', 'LOG10(100) → 2'),
    f(MYSQL, 'LOG2', 'LOG2($0)', 'math', 'Returns the base-2 logarithm.', 'LOG2(8) → 3'),
    f(MYSQL, 'SIN', 'SIN($0)', 'math', 'Sine, argument in radians.', 'SIN(PI()/2) → 1'),
    f(MYSQL, 'COS', 'COS($0)', 'math', 'Cosine, argument in radians.', 'COS(0) → 1'),
    f(MYSQL, 'TAN', 'TAN($0)', 'math', 'Tangent, argument in radians.', 'TAN(0) → 0'),
    f(MYSQL, 'ASIN', 'ASIN($0)', 'math', 'Arc sine, result in radians.', 'ASIN(1) → 1.570796'),
    f(MYSQL, 'ACOS', 'ACOS($0)', 'math', 'Arc cosine, result in radians.', 'ACOS(1) → 0'),
    f(MYSQL, 'ATAN', 'ATAN($0)', 'math', 'Arc tangent, result in radians.', 'ATAN(0) → 0'),
    f(MYSQL, 'ATAN2', 'ATAN2(${1:y}, ${2:x})', 'math', 'Arc tangent of y/x, result in radians.', 'ATAN2(1, 1)'),
    f(MYSQL, 'COT', 'COT($0)', 'math', 'Cotangent, argument in radians.', 'COT(PI()/4) → 1'),
    f(MYSQL, 'DEGREES', 'DEGREES($0)', 'math', 'Converts radians to degrees.', 'DEGREES(PI()) → 180'),
    f(MYSQL, 'RADIANS', 'RADIANS($0)', 'math', 'Converts degrees to radians.', 'RADIANS(180) → 3.141593'),
    f(MYSQL, 'CRC32', 'CRC32($0)', 'math', 'Returns a cyclic redundancy check value as an unsigned 32-bit number.', "CRC32('hello')"),
    f(MYSQL, 'BIT_COUNT', 'BIT_COUNT($0)', 'math', 'Returns the number of bits that are set.', 'BIT_COUNT(5) → 2'),

    f(MYSQL, 'JSON_ARRAY', 'JSON_ARRAY($0)', 'json', 'Creates a JSON array from the arguments.', "JSON_ARRAY(1, 'a') → [1, \"a\"]"),
    f(MYSQL, 'JSON_OBJECT', 'JSON_OBJECT(${1:key}, ${2:value})', 'json', 'Creates a JSON object from key/value pairs.', "JSON_OBJECT('id', 1) → {\"id\": 1}"),
    f(MYSQL, 'JSON_EXTRACT', 'JSON_EXTRACT(${1:json}, ${2:path})', 'json', 'Returns data from a JSON document at a path. Also written as json->path.', "JSON_EXTRACT('{\"a\":1}', '$.a') → 1"),
    f(MYSQL, 'JSON_UNQUOTE', 'JSON_UNQUOTE($0)', 'json', 'Unquotes a JSON value to a string. Often used with JSON_EXTRACT.', "JSON_UNQUOTE('\"hi\"') → 'hi'"),
    f(MYSQL, 'JSON_QUOTE', 'JSON_QUOTE($0)', 'json', 'Quotes a string as a JSON string.', "JSON_QUOTE('hi') → '\"hi\"'"),
    f(MYSQL, 'JSON_SET', 'JSON_SET(${1:json}, ${2:path}, ${3:value})', 'json', 'Inserts or updates values at paths in a JSON document.', "JSON_SET('{}', '$.a', 1)"),
    f(MYSQL, 'JSON_INSERT', 'JSON_INSERT(${1:json}, ${2:path}, ${3:value})', 'json', 'Inserts values at paths that do not already exist.', "JSON_INSERT('{\"a\":1}', '$.b', 2)"),
    f(MYSQL, 'JSON_REPLACE', 'JSON_REPLACE(${1:json}, ${2:path}, ${3:value})', 'json', 'Replaces values only at paths that already exist.', "JSON_REPLACE('{\"a\":1}', '$.a', 2)"),
    f(MYSQL, 'JSON_REMOVE', 'JSON_REMOVE(${1:json}, ${2:path})', 'json', 'Removes data from a JSON document at a path.', "JSON_REMOVE('{\"a\":1,\"b\":2}', '$.a')"),
    f(MYSQL, 'JSON_ARRAY_APPEND', 'JSON_ARRAY_APPEND(${1:json}, ${2:path}, ${3:value})', 'json', 'Appends a value to a JSON array at a path.', "JSON_ARRAY_APPEND('[1]', '$', 2)"),
    f(MYSQL, 'JSON_ARRAY_INSERT', 'JSON_ARRAY_INSERT(${1:json}, ${2:path}, ${3:value})', 'json', 'Inserts a value into a JSON array at a path.', "JSON_ARRAY_INSERT('[1,3]', '$[1]', 2)"),
    f(MYSQL, 'JSON_CONTAINS', 'JSON_CONTAINS(${1:json}, ${2:candidate})', 'json', 'Returns 1 if the candidate document is contained in the JSON document.', "JSON_CONTAINS('[1,2]', '1') → 1"),
    f(MYSQL, 'JSON_CONTAINS_PATH', 'JSON_CONTAINS_PATH(${1:json}, ${2:one}, ${3:path})', 'json', 'Returns whether a JSON document contains a path. Second arg is one or all.', "JSON_CONTAINS_PATH('{\"a\":1}', 'one', '$.a') → 1"),
    f(MYSQL, 'JSON_DEPTH', 'JSON_DEPTH($0)', 'json', 'Returns the maximum depth of a JSON document.', "JSON_DEPTH('[1, {\"a\": 2}]') → 3"),
    f(MYSQL, 'JSON_KEYS', 'JSON_KEYS($0)', 'json', 'Returns the keys from a JSON object as a JSON array.', "JSON_KEYS('{\"a\":1,\"b\":2}') → [\"a\", \"b\"]"),
    f(MYSQL, 'JSON_LENGTH', 'JSON_LENGTH($0)', 'json', 'Returns the length of a JSON document (array items or object keys).', "JSON_LENGTH('[1,2,3]') → 3"),
    f(MYSQL, 'JSON_TYPE', 'JSON_TYPE($0)', 'json', 'Returns the JSON type of a value (OBJECT, ARRAY, INTEGER, …).', "JSON_TYPE('[]') → 'ARRAY'"),
    f(MYSQL, 'JSON_VALID', 'JSON_VALID($0)', 'json', 'Returns 1 if the argument is valid JSON.', "JSON_VALID('{\"a\":1}') → 1"),
    f(MYSQL, 'JSON_SEARCH', 'JSON_SEARCH(${1:json}, ${2:one}, ${3:str})', 'json', 'Finds paths to a string in a JSON document.', "JSON_SEARCH('[\"a\",\"b\"]', 'one', 'b') → '$[1]'"),
    f(MYSQL, 'JSON_MERGE', 'JSON_MERGE(${1:j1}, ${2:j2})', 'json', 'Deprecated alias of JSON_MERGE_PRESERVE.', "JSON_MERGE('[1]', '[2]')"),
    f(MYSQL, 'JSON_MERGE_PATCH', 'JSON_MERGE_PATCH(${1:j1}, ${2:j2})', 'json', 'Merges JSON documents. Duplicate keys in later documents win.', "JSON_MERGE_PATCH('{\"a\":1}', '{\"a\":2}') → {\"a\": 2}"),
    f(MYSQL, 'JSON_MERGE_PRESERVE', 'JSON_MERGE_PRESERVE(${1:j1}, ${2:j2})', 'json', 'Merges JSON documents and keeps duplicate keys as arrays.', "JSON_MERGE_PRESERVE('{\"a\":1}', '{\"a\":2}')"),
    f(MYSQL, 'JSON_PRETTY', 'JSON_PRETTY($0)', 'json', 'Returns a JSON document formatted with newlines and indent.', 'JSON_PRETTY(data)'),
    f(MYSQL, 'JSON_STORAGE_SIZE', 'JSON_STORAGE_SIZE($0)', 'json', 'Returns the binary storage size of a JSON document.', 'JSON_STORAGE_SIZE(data)'),
    f(MYSQL, 'JSON_STORAGE_FREE', 'JSON_STORAGE_FREE($0)', 'json', 'Returns free space in a JSON binary representation after in-place updates.', 'JSON_STORAGE_FREE(data)'),
    f(MYSQL, 'JSON_SCHEMA_VALID', 'JSON_SCHEMA_VALID(${1:schema}, ${2:doc})', 'json', 'Returns 1 if the document is valid against a JSON schema.', 'JSON_SCHEMA_VALID(schema, doc)'),
    f(MYSQL, 'JSON_SCHEMA_VALIDATION_REPORT', 'JSON_SCHEMA_VALIDATION_REPORT(${1:schema}, ${2:doc})', 'json', 'Returns a JSON report of schema validation.', 'JSON_SCHEMA_VALIDATION_REPORT(schema, doc)'),
    f(MYSQL, 'JSON_VALUE', 'JSON_VALUE(${1:json}, ${2:path})', 'json', 'Returns a scalar from a JSON document at a path, unquoted.', "JSON_VALUE('{\"a\":\"x\"}', '$.a') → 'x'"),
    f(MYSQL, 'JSON_TABLE', 'JSON_TABLE(${1:json}, ${2:path} COLUMNS ($0))', 'json', 'Turns a JSON document into a table for use in FROM.', "JSON_TABLE(data, '$[*]' COLUMNS (id INT PATH '$.id'))"),
    f(MYSQL, 'JSON_OVERLAPS', 'JSON_OVERLAPS(${1:j1}, ${2:j2})', 'json', 'Returns 1 if two JSON documents have any key-value pairs or array elements in common.', "JSON_OVERLAPS('[1,2]', '[2,3]') → 1"),
    f(MYSQL, 'JSON_ARRAYAGG', 'JSON_ARRAYAGG($0)', 'json', 'Aggregate: builds a JSON array from a group.', 'JSON_ARRAYAGG(name)'),
    f(MYSQL, 'JSON_OBJECTAGG', 'JSON_OBJECTAGG(${1:key}, ${2:value})', 'json', 'Aggregate: builds a JSON object from key/value pairs in a group.', 'JSON_OBJECTAGG(id, name)'),

    f(MYSQL, 'MD5', 'MD5($0)', 'crypto', 'Returns the MD5 128-bit checksum as a hex string.', "MD5('abc')"),
    f(MYSQL, 'SHA1', 'SHA1($0)', 'crypto', 'Returns the SHA-1 160-bit checksum as a hex string.', "SHA1('abc')"),
    f(MYSQL, 'SHA2', 'SHA2(${1:str}, ${2:256})', 'crypto', 'Returns a SHA-2 checksum. Length is 224, 256, 384, or 512.', "SHA2('abc', 256)"),
    f(MYSQL, 'AES_ENCRYPT', 'AES_ENCRYPT(${1:str}, ${2:key})', 'crypto', 'Encrypts a string with AES.', 'AES_ENCRYPT(secret, key)'),
    f(MYSQL, 'AES_DECRYPT', 'AES_DECRYPT(${1:blob}, ${2:key})', 'crypto', 'Decrypts an AES_ENCRYPT value.', 'AES_DECRYPT(blob, key)'),
    f(MYSQL, 'RANDOM_BYTES', 'RANDOM_BYTES($0)', 'crypto', 'Returns a binary string of cryptographically random bytes.', 'RANDOM_BYTES(16)'),
    f(MYSQL, 'VALIDATE_PASSWORD_STRENGTH', 'VALIDATE_PASSWORD_STRENGTH($0)', 'crypto', 'Returns a password strength score from 0 to 100.', "VALIDATE_PASSWORD_STRENGTH('s3cret')"),

    f(MYSQL, 'UUID', 'UUID()', 'other', 'Returns a UUID as a string (version 1).', 'UUID()'),
    f(MYSQL, 'UUID_SHORT', 'UUID_SHORT()', 'other', 'Returns a 64-bit unsigned integer UUID.', 'UUID_SHORT()'),
    f(MYSQL, 'UUID_TO_BIN', 'UUID_TO_BIN($0)', 'other', 'Converts a UUID string to a compact binary value.', 'UUID_TO_BIN(id)'),
    f(MYSQL, 'BIN_TO_UUID', 'BIN_TO_UUID($0)', 'other', 'Converts a binary UUID back to a string.', 'BIN_TO_UUID(id)'),
    f(MYSQL, 'IS_UUID', 'IS_UUID($0)', 'other', 'Returns 1 if the argument is a valid UUID string.', "IS_UUID('a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11') → 1"),
    f(MYSQL, 'LAST_INSERT_ID', 'LAST_INSERT_ID()', 'other', 'Returns the last AUTO_INCREMENT value generated in this session.', 'LAST_INSERT_ID()'),
    f(MYSQL, 'DATABASE', 'DATABASE()', 'other', 'Returns the default database name, or NULL if none is selected.', 'DATABASE()'),
    f(MYSQL, 'SCHEMA', 'SCHEMA()', 'other', 'Alias of DATABASE().', 'SCHEMA()'),
    f(MYSQL, 'VERSION', 'VERSION()', 'other', 'Returns the MySQL server version.', 'VERSION()'),
    f(MYSQL, 'CONNECTION_ID', 'CONNECTION_ID()', 'other', 'Returns the connection ID (thread ID) for this session.', 'CONNECTION_ID()'),
    f(MYSQL, 'CURRENT_USER', 'CURRENT_USER()', 'other', 'Returns the authenticated user name and host.', 'CURRENT_USER()'),
    f(MYSQL, 'SESSION_USER', 'SESSION_USER()', 'other', 'Returns the current MySQL user name and host.', 'SESSION_USER()'),
    f(MYSQL, 'SYSTEM_USER', 'SYSTEM_USER()', 'other', 'Alias of SESSION_USER().', 'SYSTEM_USER()'),
    f(MYSQL, 'CURRENT_ROLE', 'CURRENT_ROLE()', 'other', 'Returns the current active roles.', 'CURRENT_ROLE()'),
    f(MYSQL, 'ROW_COUNT', 'ROW_COUNT()', 'other', 'Returns the number of rows changed by the previous statement.', 'ROW_COUNT()'),
    f(MYSQL, 'FOUND_ROWS', 'FOUND_ROWS()', 'other', 'Returns the number of rows the last SELECT would have returned without LIMIT (needs SQL_CALC_FOUND_ROWS).', 'FOUND_ROWS()'),
    f(MYSQL, 'CHARSET', 'CHARSET($0)', 'other', 'Returns the character set of a string.', "CHARSET('abc') → 'utf8mb4'"),
    f(MYSQL, 'COLLATION', 'COLLATION($0)', 'other', 'Returns the collation of a string.', 'COLLATION(name)'),
    f(MYSQL, 'COERCIBILITY', 'COERCIBILITY($0)', 'other', 'Returns the collation coercibility of an expression (0–5).', "COERCIBILITY('abc')"),
    f(MYSQL, 'INET_ATON', 'INET_ATON($0)', 'network', 'Converts an IPv4 address to an integer.', "INET_ATON('127.0.0.1') → 2130706433"),
    f(MYSQL, 'INET_NTOA', 'INET_NTOA($0)', 'network', 'Converts an integer to an IPv4 address.', "INET_NTOA(2130706433) → '127.0.0.1'"),
    f(MYSQL, 'INET6_ATON', 'INET6_ATON($0)', 'network', 'Converts an IPv6 (or IPv4) address to a binary value.', "INET6_ATON('::1')"),
    f(MYSQL, 'INET6_NTOA', 'INET6_NTOA($0)', 'network', 'Converts a binary IPv6 value to a string.', 'INET6_NTOA(bin)'),
    f(MYSQL, 'IS_IPV4', 'IS_IPV4($0)', 'network', 'Returns 1 if the argument is a valid IPv4 address.', "IS_IPV4('127.0.0.1') → 1"),
    f(MYSQL, 'IS_IPV4_COMPAT', 'IS_IPV4_COMPAT($0)', 'network', 'Returns 1 if the binary value is an IPv4-compatible IPv6 address.', 'IS_IPV4_COMPAT(bin)'),
    f(MYSQL, 'IS_IPV4_MAPPED', 'IS_IPV4_MAPPED($0)', 'network', 'Returns 1 if the binary value is an IPv4-mapped IPv6 address.', 'IS_IPV4_MAPPED(bin)'),
    f(MYSQL, 'IS_IPV6', 'IS_IPV6($0)', 'network', 'Returns 1 if the argument is a valid IPv6 address.', "IS_IPV6('::1') → 1"),
    f(MYSQL, 'GET_LOCK', 'GET_LOCK(${1:name}, ${2:timeout})', 'lock', 'Gets a named advisory lock. Returns 1 on success.', "GET_LOCK('job', 10)"),
    f(MYSQL, 'RELEASE_LOCK', 'RELEASE_LOCK($0)', 'lock', 'Releases a named advisory lock.', "RELEASE_LOCK('job')"),
    f(MYSQL, 'RELEASE_ALL_LOCKS', 'RELEASE_ALL_LOCKS()', 'lock', 'Releases all advisory locks held by this session.', 'RELEASE_ALL_LOCKS()'),
    f(MYSQL, 'IS_FREE_LOCK', 'IS_FREE_LOCK($0)', 'lock', 'Returns 1 if the named lock is free.', "IS_FREE_LOCK('job')"),
    f(MYSQL, 'IS_USED_LOCK', 'IS_USED_LOCK($0)', 'lock', 'Returns the connection ID that holds the named lock, or NULL.', "IS_USED_LOCK('job')"),
    f(MYSQL, 'EXTRACTVALUE', 'EXTRACTVALUE(${1:xml}, ${2:xpath})', 'xml', 'Returns a CDATA fragment from XML using an XPath expression.', "EXTRACTVALUE('<a>1</a>', '/a') → '1'"),
    f(MYSQL, 'UPDATEXML', 'UPDATEXML(${1:xml}, ${2:xpath}, ${3:new})', 'xml', 'Replaces a fragment of XML matching an XPath expression.', "UPDATEXML('<a>1</a>', '/a', '<a>2</a>')"),
    f(MYSQL, 'SLEEP', 'SLEEP($0)', 'other', 'Pauses for the given number of seconds. Returns 0.', 'SLEEP(1)'),
    f(MYSQL, 'BENCHMARK', 'BENCHMARK(${1:count}, ${2:expr})', 'other', 'Runs an expression count times. Used to time expressions.', 'BENCHMARK(1000, MD5(name))'),
    f(MYSQL, 'FORMAT_BYTES', 'FORMAT_BYTES($0)', 'other', 'Formats a byte count as a human-readable string.', "FORMAT_BYTES(1024) → '1.00 KiB'"),
    f(MYSQL, 'FORMAT_PICO_TIME', 'FORMAT_PICO_TIME($0)', 'other', 'Formats a picosecond time as a human-readable string.', 'FORMAT_PICO_TIME(1000000000000)'),
    f(MYSQL, 'STATEMENT_DIGEST', 'STATEMENT_DIGEST($0)', 'other', 'Returns a normalized digest hash of a SQL statement.', 'STATEMENT_DIGEST(sql_text)'),
    f(MYSQL, 'STATEMENT_DIGEST_TEXT', 'STATEMENT_DIGEST_TEXT($0)', 'other', 'Returns the normalized digest text of a SQL statement.', 'STATEMENT_DIGEST_TEXT(sql_text)'),
    f(MYSQL, 'ICU_VERSION', 'ICU_VERSION()', 'other', 'Returns the ICU library version used for regular expressions.', 'ICU_VERSION()'),
    f(MYSQL, 'PS_CURRENT_THREAD_ID', 'PS_CURRENT_THREAD_ID()', 'other', 'Returns the Performance Schema thread ID for this session.', 'PS_CURRENT_THREAD_ID()'),
    f(MYSQL, 'PS_THREAD_ID', 'PS_THREAD_ID($0)', 'other', 'Returns the Performance Schema thread ID for a connection ID.', 'PS_THREAD_ID(CONNECTION_ID())'),
    f(MYSQL, 'GTID_SUBSET', 'GTID_SUBSET(${1:set1}, ${2:set2})', 'replication', 'Returns 1 if all GTIDs in set1 are also in set2.', 'GTID_SUBSET(a, b)'),
    f(MYSQL, 'GTID_SUBTRACT', 'GTID_SUBTRACT(${1:set1}, ${2:set2})', 'replication', 'Returns GTIDs in set1 that are not in set2.', 'GTID_SUBTRACT(a, b)'),
    f(MYSQL, 'WAIT_FOR_EXECUTED_GTID_SET', 'WAIT_FOR_EXECUTED_GTID_SET($0)', 'replication', 'Waits until the given GTIDs have been executed on this server.', 'WAIT_FOR_EXECUTED_GTID_SET(gtids)'),
    f(MYSQL, 'WAIT_UNTIL_SQL_THREAD_AFTER_GTIDS', 'WAIT_UNTIL_SQL_THREAD_AFTER_GTIDS($0)', 'replication', 'Deprecated replica wait helper. Prefer WAIT_FOR_EXECUTED_GTID_SET.', 'WAIT_UNTIL_SQL_THREAD_AFTER_GTIDS(gtids)'),
    f(MYSQL, 'SOURCE_POS_WAIT', 'SOURCE_POS_WAIT(${1:file}, ${2:pos})', 'replication', 'Waits until the replica has read the given source log position.', "SOURCE_POS_WAIT('binlog.000001', 4)"),
    f(MYSQL, 'MASTER_POS_WAIT', 'MASTER_POS_WAIT(${1:file}, ${2:pos})', 'replication', 'Deprecated alias of SOURCE_POS_WAIT.', "MASTER_POS_WAIT('binlog.000001', 4)"),
    f(MYSQL, 'ROLES_GRAPHML', 'ROLES_GRAPHML()', 'other', 'Returns a GraphML document of the role privilege graph.', 'ROLES_GRAPHML()'),

    ...mysqlNamed(
        'spatial',
        [
            ['ST_GEOMFROMTEXT', 'ST_GEOMFROMTEXT($0)', 'Creates a geometry from WKT text.', "ST_GEOMFROMTEXT('POINT(1 1)')"],
            ['ST_GEOMFROMWKB', 'ST_GEOMFROMWKB($0)', 'Creates a geometry from WKB bytes.', 'ST_GEOMFROMWKB(blob)'],
            ['ST_GEOMFROMGEOJSON', 'ST_GEOMFROMGEOJSON($0)', 'Creates a geometry from a GeoJSON string.', 'ST_GEOMFROMGEOJSON(json)'],
            ['ST_ASTEXT', 'ST_ASTEXT($0)', 'Returns the WKT text of a geometry.', 'ST_ASTEXT(g)'],
            ['ST_ASBINARY', 'ST_ASBINARY($0)', 'Returns the WKB bytes of a geometry.', 'ST_ASBINARY(g)'],
            ['ST_ASGEOJSON', 'ST_ASGEOJSON($0)', 'Returns a GeoJSON string for a geometry.', 'ST_ASGEOJSON(g)'],
            ['ST_X', 'ST_X($0)', 'Returns the X coordinate of a point.', 'ST_X(pt)'],
            ['ST_Y', 'ST_Y($0)', 'Returns the Y coordinate of a point.', 'ST_Y(pt)'],
            ['ST_LATITUDE', 'ST_LATITUDE($0)', 'Returns the latitude of a geographic point.', 'ST_LATITUDE(pt)'],
            ['ST_LONGITUDE', 'ST_LONGITUDE($0)', 'Returns the longitude of a geographic point.', 'ST_LONGITUDE(pt)'],
            ['ST_SRID', 'ST_SRID($0)', 'Returns or sets the spatial reference ID of a geometry.', 'ST_SRID(g)'],
            ['ST_DISTANCE', 'ST_DISTANCE(${1:g1}, ${2:g2})', 'Returns the distance between two geometries.', 'ST_DISTANCE(g1, g2)'],
            ['ST_DISTANCE_SPHERE', 'ST_DISTANCE_SPHERE(${1:g1}, ${2:g2})', 'Returns the spherical distance in metres between two points.', 'ST_DISTANCE_SPHERE(p1, p2)'],
            ['ST_CONTAINS', 'ST_CONTAINS(${1:g1}, ${2:g2})', 'Returns 1 if g1 contains g2.', 'ST_CONTAINS(poly, pt)'],
            ['ST_WITHIN', 'ST_WITHIN(${1:g1}, ${2:g2})', 'Returns 1 if g1 is within g2.', 'ST_WITHIN(pt, poly)'],
            ['ST_INTERSECTS', 'ST_INTERSECTS(${1:g1}, ${2:g2})', 'Returns 1 if the geometries intersect.', 'ST_INTERSECTS(g1, g2)'],
            ['ST_EQUALS', 'ST_EQUALS(${1:g1}, ${2:g2})', 'Returns 1 if the geometries are spatially equal.', 'ST_EQUALS(g1, g2)'],
            ['ST_DISJOINT', 'ST_DISJOINT(${1:g1}, ${2:g2})', 'Returns 1 if the geometries do not intersect.', 'ST_DISJOINT(g1, g2)'],
            ['ST_OVERLAPS', 'ST_OVERLAPS(${1:g1}, ${2:g2})', 'Returns 1 if the geometries overlap.', 'ST_OVERLAPS(g1, g2)'],
            ['ST_TOUCHES', 'ST_TOUCHES(${1:g1}, ${2:g2})', 'Returns 1 if the geometries touch but do not overlap interiors.', 'ST_TOUCHES(g1, g2)'],
            ['ST_CROSSES', 'ST_CROSSES(${1:g1}, ${2:g2})', 'Returns 1 if the geometries cross.', 'ST_CROSSES(g1, g2)'],
            ['ST_AREA', 'ST_AREA($0)', 'Returns the area of a polygon.', 'ST_AREA(poly)'],
            ['ST_LENGTH', 'ST_LENGTH($0)', 'Returns the length of a linestring.', 'ST_LENGTH(line)'],
            ['ST_BUFFER', 'ST_BUFFER(${1:g}, ${2:distance})', 'Returns a geometry covering all points within a distance.', 'ST_BUFFER(g, 1)'],
            ['ST_CENTROID', 'ST_CENTROID($0)', 'Returns the centroid of a geometry.', 'ST_CENTROID(poly)'],
            ['ST_ENVELOPE', 'ST_ENVELOPE($0)', 'Returns the minimum bounding rectangle as a polygon.', 'ST_ENVELOPE(g)'],
            ['ST_GEOMETRYTYPE', 'ST_GEOMETRYTYPE($0)', 'Returns the geometry type name.', 'ST_GEOMETRYTYPE(g)'],
            ['ST_ISVALID', 'ST_ISVALID($0)', 'Returns 1 if the geometry is valid.', 'ST_ISVALID(g)'],
            ['ST_ISEMPTY', 'ST_ISEMPTY($0)', 'Returns 1 if the geometry is empty.', 'ST_ISEMPTY(g)'],
            ['ST_ISSIMPLE', 'ST_ISSIMPLE($0)', 'Returns 1 if the geometry has no anomalies (self-intersections, …).', 'ST_ISSIMPLE(g)'],
            ['ST_ISCLOSED', 'ST_ISCLOSED($0)', 'Returns 1 if a linestring start and end are the same.', 'ST_ISCLOSED(line)'],
            ['ST_TRANSFORM', 'ST_TRANSFORM(${1:g}, ${2:srid})', 'Transforms a geometry to another SRID.', 'ST_TRANSFORM(g, 4326)'],
            ['POINT', 'POINT(${1:x}, ${2:y})', 'Creates a point geometry.', 'POINT(1, 2)'],
            ['LINESTRING', 'LINESTRING($0)', 'Creates a linestring from points.', 'LINESTRING(pt1, pt2)'],
            ['POLYGON', 'POLYGON($0)', 'Creates a polygon from rings.', 'POLYGON(ring)'],
            ['MULTIPOINT', 'MULTIPOINT($0)', 'Creates a multipoint geometry.', 'MULTIPOINT(pt1, pt2)'],
            ['MULTILINESTRING', 'MULTILINESTRING($0)', 'Creates a multilinestring geometry.', 'MULTILINESTRING(line1, line2)'],
            ['MULTIPOLYGON', 'MULTIPOLYGON($0)', 'Creates a multipolygon geometry.', 'MULTIPOLYGON(poly1, poly2)'],
            ['GEOMCOLLECTION', 'GEOMCOLLECTION($0)', 'Creates a geometry collection.', 'GEOMCOLLECTION(g1, g2)'],
            ['GEOMETRYCOLLECTION', 'GEOMETRYCOLLECTION($0)', 'Alias of GEOMCOLLECTION.', 'GEOMETRYCOLLECTION(g1, g2)']
        ]
    ),
    ...mysqlNamed(
        'spatial',
        [
            'ST_BUFFER_STRATEGY',
            'ST_COLLECT',
            'ST_CONVEXHULL',
            'ST_DIFFERENCE',
            'ST_DIMENSION',
            'ST_ENDPOINT',
            'ST_EXTERIORRING',
            'ST_FRECHETDISTANCE',
            'ST_GEOHASH',
            'ST_GEOMCOLLFROMTEXT',
            'ST_GEOMCOLLFROMWKB',
            'ST_GEOMETRYN',
            'ST_HAUSDORFFDISTANCE',
            'ST_INTERIORRINGN',
            'ST_INTERSECTION',
            'ST_LATFROMGEOHASH',
            'ST_LINEFROMTEXT',
            'ST_LINEFROMWKB',
            'ST_LINEINTERPOLATEPOINT',
            'ST_LINEINTERPOLATEPOINTS',
            'ST_LONGFROMGEOHASH',
            'ST_MAKEENVELOPE',
            'ST_MLINEFROMTEXT',
            'ST_MLINEFROMWKB',
            'ST_MPOINTFROMTEXT',
            'ST_MPOINTFROMWKB',
            'ST_MPOLYFROMTEXT',
            'ST_MPOLYFROMWKB',
            'ST_NUMGEOMETRIES',
            'ST_NUMINTERIORRING',
            'ST_NUMPOINTS',
            'ST_POINTATDISTANCE',
            'ST_POINTFROMGEOHASH',
            'ST_POINTFROMTEXT',
            'ST_POINTFROMWKB',
            'ST_POINTN',
            'ST_POLYFROMTEXT',
            'ST_POLYFROMWKB',
            'ST_SIMPLIFY',
            'ST_STARTPOINT',
            'ST_SWAPXY',
            'ST_SYMDIFFERENCE',
            'ST_UNION',
            'ST_VALIDATE',
            'MBRCONTAINS',
            'MBRCOVEREDBY',
            'MBRCOVERS',
            'MBRDISJOINT',
            'MBREQUALS',
            'MBRINTERSECTS',
            'MBROVERLAPS',
            'MBRTOUCHES',
            'MBRWITHIN'
        ].map((name) => [name, `${name}($0)`, `MySQL spatial function ${name}.`, `${name}(...)`])
    )
];

function mysqlNamed(
    detail: string,
    rows: Array<[string, string, string, string]>
): SqlFunctionInfo[] {
    return rows.map(([name, snippet, documentation, example]) =>
        f(MYSQL, name, snippet, detail, documentation, example)
    );
}

export const SQL_FUNCTIONS: SqlFunctionInfo[] = [...COMMON, ...MSSQL_ONLY, ...MYSQL_ONLY];

const byLower = new Map<string, SqlFunctionInfo[]>();
for (const fn of SQL_FUNCTIONS) {
    const key = fn.name.toLowerCase();
    const list = byLower.get(key);
    if (list) {
        list.push(fn);
    } else {
        byLower.set(key, [fn]);
    }
}

export function functionsForEngine(engine: FunctionEngine): SqlFunctionInfo[] {
    return SQL_FUNCTIONS.filter((fn) => fn.engines.includes(engine));
}

export function findSqlFunction(
    name: string,
    engine?: FunctionEngine
): SqlFunctionInfo | undefined {
    const list = byLower.get(name.toLowerCase());
    if (!list) {
        return undefined;
    }
    if (!engine) {
        return list[0];
    }
    return list.find((fn) => fn.engines.includes(engine));
}

export function isSqlFunctionName(name: string): boolean {
    return byLower.has(name.toLowerCase());
}

export function functionMarkdown(fn: SqlFunctionInfo): string {
    return `${fn.documentation}\n\n**Example:** \`${fn.example}\``;
}

/** Returns true when a SQL identifier needs [bracket] quoting. */
export function needsBrackets(name: string): boolean {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
        return true;
    }
    // Common reserved words that break unquoted identifiers.
    const reserved = new Set([
        'user', 'order', 'group', 'select', 'table', 'index', 'key', 'value',
        'values', 'type', 'plan', 'file', 'rule', 'check', 'default', 'null',
        'primary', 'foreign', 'references', 'constraint', 'transaction'
    ]);
    return reserved.has(name.toLowerCase());
}

export function quoteIdent(name: string, engine: FunctionEngine = 'mssql'): string {
    if (!needsBrackets(name)) {
        return name;
    }
    if (engine === 'mysql') {
        return `\`${name.replace(/`/g, '``')}\``;
    }
    return `[${name.replace(/]/g, ']]')}]`;
}
