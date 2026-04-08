export function inferBasicType(dataType: string): string | null {
  const upper = dataType.toUpperCase()
  if (/^(INT|INTEGER|BIGINT|SMALLINT|TINYINT|INT2|INT4|INT8|INT64|NUMBER\s*\(\s*\d+\s*,\s*0\s*\))/.test(upper)) return 'integer'
  if (/^(FLOAT|DOUBLE|REAL|DECIMAL|NUMERIC|NUMBER|MONEY|SMALLMONEY)/.test(upper)) return 'decimal'
  if (/^(VARCHAR|NVARCHAR|CHARACTER\s+VARYING|CHAR|NCHAR|TEXT|CLOB|STRING|LONGTEXT|MEDIUMTEXT|TINYTEXT)/.test(upper)) return 'string'
  if (/^(BOOLEAN|BOOL|BIT)/.test(upper)) return 'boolean'
  if (/^DATE$/.test(upper)) return 'date'
  if (/^(TIMESTAMP|DATETIME|DATETIME2|SMALLDATETIME)/.test(upper)) return 'datetime'
  if (/^(TIME)/.test(upper)) return 'string'
  return null
}
