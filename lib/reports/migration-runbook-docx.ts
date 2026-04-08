import {
  AlignmentType,
  BorderStyle,
  Document,
  Footer,
  Header,
  HeadingLevel,
  LevelFormat,
  Packer,
  PageBreak,
  PageNumber,
  Paragraph,
  ShadingType,
  Table,
  TableCell,
  TableRow,
  TextRun,
  WidthType,
} from 'docx'

// ── Public data shape ─────────────────────────────────────────────────────────

export interface RunbookData {
  projectName: string
  sourceSystemName: string
  targetSystemName: string
  generatedAt: string

  // Stats (computed server-side)
  totalSourceRecords: number
  totalSourceTables: number
  totalTargetTables: number
  totalFieldMappings: number
  totalTransformations: number
  migrationReadinessPercent: number

  // Claude-generated content
  executiveSummary: string
  preMigrationChecklist: string[]
  mappingSpecification: Array<{
    sourceTable: string
    targetTable: string
    fieldCount: number
    keyTransformations: string[]
    unmappedFields: string[]
  }>
  transformationRules: Array<{
    targetField: string
    sourceField: string
    ruleDescription: string
    valueMappingTable?: Array<{ source: string; target: string }>
  }>
  dataQualityAssessment: {
    totalIssuesFound: number
    issuesFixed: number
    issuesAcceptedRisk: number
    issuesRemaining: number
    blockingRemaining: number
    summaryNarrative: string
    keyFindings: string[]
  }
  executionPlan: Array<{
    stepNumber: number
    title: string
    description: string
    verificationCriteria: string[]
  }>
  validationCriteria: Array<{
    criterion: string
    threshold: string
    passCondition: string
  }>
  rollbackProcedure: string
  loadOrder: Array<{
    order: number
    tableName: string
    dependencies: string[]
  }>
}

type DocChild = Paragraph | Table

// ── Public entry point ────────────────────────────────────────────────────────

export async function buildMigrationRunbook(data: RunbookData): Promise<Buffer> {
  const children: DocChild[] = []

  // Cover block
  children.push(...buildCoverBlock(data))

  // Section 1: Executive Summary
  children.push(buildH1('1. Executive Summary'))
  children.push(para(data.executiveSummary))
  children.push(buildStatsTable([
    ['Source System', data.sourceSystemName],
    ['Target System', data.targetSystemName],
    ['Source Tables', String(data.totalSourceTables)],
    ['Target Tables', String(data.totalTargetTables)],
    ['Total Source Records', data.totalSourceRecords.toLocaleString()],
    ['Field Mappings', String(data.totalFieldMappings)],
    ['Transformations', String(data.totalTransformations)],
    ['Migration Readiness', `${data.migrationReadinessPercent}%`],
  ]))
  children.push(spacer())

  // Section 2: Pre-Migration Checklist
  children.push(buildH1('2. Pre-Migration Checklist'))
  children.push(para('Complete all items before executing the migration. Each item requires sign-off.'))
  for (const item of data.preMigrationChecklist) {
    children.push(bullet(`☐  ${item}`))
    children.push(grayPara('Completed by: _________________ Date: _______'))
  }
  children.push(spacer())
  children.push(para('All pre-migration checks completed and approved:'))
  children.push(grayPara('Migration Lead: _________________________________ Date: _____________'))
  children.push(grayPara('Business Owner: _________________________________ Date: _____________'))
  children.push(spacer())

  // Section 3: Data Mapping Specification
  children.push(buildH1('3. Data Mapping Specification'))
  for (const mapping of data.mappingSpecification) {
    children.push(buildH2(`${mapping.sourceTable} → ${mapping.targetTable}`))
    children.push(para(`${mapping.fieldCount} field mapping${mapping.fieldCount !== 1 ? 's' : ''}`))
    if (mapping.keyTransformations.length > 0) {
      children.push(buildH3('Key Transformations:'))
      for (const t of mapping.keyTransformations) children.push(bullet(t))
    }
    if (mapping.unmappedFields.length > 0) {
      children.push(buildH3('Unmapped Source Fields (not migrated):'))
      for (const f of mapping.unmappedFields) children.push(bullet(f))
    }
    children.push(spacer())
  }

  // Section 4: Transformation Rules
  children.push(buildH1('4. Transformation Rules'))
  children.push(para('The following transformations are applied during migration. All rules have been tested against source data.'))
  for (const rule of data.transformationRules) {
    children.push(boldPara(`${rule.sourceField} → ${rule.targetField}`))
    children.push(para(rule.ruleDescription))
    if (rule.valueMappingTable && rule.valueMappingTable.length > 0) {
      children.push(
        buildFlexTable(
          ['Source Value', 'Target Value'],
          rule.valueMappingTable.map((r) => [r.source, r.target]),
          [4680, 4680]
        )
      )
      children.push(new Paragraph({ children: [], spacing: { after: 120 } }))
    }
  }
  children.push(spacer())

  // Section 5: Data Quality Assessment
  children.push(buildH1('5. Data Quality Assessment'))
  const dqa = data.dataQualityAssessment
  children.push(
    buildStatsTable([
      ['Total Issues Detected', String(dqa.totalIssuesFound)],
      ['Issues Fixed', String(dqa.issuesFixed)],
      ['Accepted Risks', String(dqa.issuesAcceptedRisk)],
      ['Remaining Open', String(dqa.issuesRemaining)],
      ['Blocking (Remaining)', String(dqa.blockingRemaining)],
    ])
  )
  children.push(spacer())
  children.push(para(dqa.summaryNarrative))
  if (dqa.keyFindings.length > 0) {
    children.push(buildH3('Key Findings'))
    for (const f of dqa.keyFindings) children.push(bullet(f))
  }
  children.push(spacer())

  // Section 6: Execution Plan
  children.push(buildH1('6. Execution Plan'))
  children.push(para('Execute the following steps in order. Each step includes verification criteria that must pass before proceeding.'))
  children.push(para('Reference: The SQL scripts for each step are in the Migration Execution Package (.sql file).'))
  for (const step of data.executionPlan) {
    children.push(buildH2(`Step ${step.stepNumber}: ${step.title}`))
    children.push(para(step.description))
    if (step.verificationCriteria.length > 0) {
      children.push(buildH3('Verification:'))
      for (const c of step.verificationCriteria) children.push(bullet(c))
    }
    children.push(grayPara('Verified by: _________________ Date: _______'))
    children.push(spacer())
  }

  // Section 7: Validation Criteria
  children.push(buildH1('7. Validation Criteria'))
  children.push(para('The migration passes validation when ALL of the following criteria are met:'))
  children.push(
    buildFlexTable(
      ['Criterion', 'Threshold', 'Pass Condition'],
      data.validationCriteria.map((v) => [v.criterion, v.threshold, v.passCondition]),
      [3120, 3120, 3120]
    )
  )
  children.push(spacer())
  children.push(boldPara('Validation Result:  □ PASS   □ FAIL'))
  children.push(grayPara('Validated by: _________________________________ Date: _____________'))
  children.push(spacer())

  // Section 8: Rollback Procedure
  children.push(buildH1('8. Rollback Procedure'))
  children.push(para(data.rollbackProcedure))
  children.push(para('The rollback SQL is available in Section 5 of the Migration Execution Package.'))
  children.push(spacer())

  // Section 9: Table Load Order
  children.push(buildH1('9. Table Load Order'))
  children.push(
    buildFlexTable(
      ['Order', 'Target Table', 'Dependencies'],
      data.loadOrder.map((l) => [
        String(l.order),
        l.tableName,
        l.dependencies.length > 0 ? l.dependencies.join(', ') : '—',
      ]),
      [1200, 4080, 4080]
    )
  )
  children.push(spacer())

  // Section 10: Related Artifacts
  children.push(buildH1('10. Appendix: Related Artifacts'))
  for (const item of [
    'Migration Execution Package (.sql) — Contains all extract, transform, load, and validation SQL',
    'Migration Readiness Report (.docx) — Executive summary and risk assessment for stakeholder review',
    'Mapping File (.csv/.json) — Complete field-level mapping specification',
    'Transformation Specs (.sql) — Individual transformation SQL per field',
    'Fix Log & Audit Trail — Chronological record of all data fixes applied',
    'Data Dictionary — Source and target schema documentation',
  ]) {
    children.push(bullet(item))
  }

  // ── Document assembly — exactly mirrors readiness-report-docx.ts ──────────

  const doc = new Document({
    styles: {
      default: {
        document: {
          run: { font: 'Arial', size: 22 },
        },
      },
      paragraphStyles: [
        {
          id: 'Heading1',
          name: 'Heading 1',
          basedOn: 'Normal',
          next: 'Normal',
          quickFormat: true,
          run: { size: 28, bold: true, font: 'Arial', color: '1E293B' },
          paragraph: { spacing: { before: 400, after: 160 }, outlineLevel: 0 },
        },
        {
          id: 'Heading2',
          name: 'Heading 2',
          basedOn: 'Normal',
          next: 'Normal',
          quickFormat: true,
          run: { size: 24, bold: true, font: 'Arial', color: '334155' },
          paragraph: { spacing: { before: 280, after: 120 }, outlineLevel: 1 },
        },
      ],
    },
    numbering: {
      config: [
        {
          reference: 'bullets',
          levels: [
            {
              level: 0,
              format: LevelFormat.BULLET,
              text: '\u2022',
              alignment: AlignmentType.LEFT,
              style: {
                paragraph: { indent: { left: 720, hanging: 360 } },
                run: { font: 'Arial', size: 22 },
              },
            },
          ],
        },
      ],
    },
    sections: [
      {
        properties: {
          page: {
            size: { width: 12240, height: 15840 }, // US Letter
            margin: { top: 1440, right: 1440, bottom: 1440, left: 1440 }, // 1 inch
          },
        },
        headers: {
          default: new Header({
            children: [
              new Paragraph({
                alignment: AlignmentType.RIGHT,
                children: [
                  new TextRun({
                    text: `${data.projectName} — Migration Runbook`,
                    size: 16,
                    color: '94A3B8',
                    font: 'Arial',
                  }),
                ],
                border: {
                  bottom: { style: BorderStyle.SINGLE, size: 1, color: 'E2E8F0', space: 4 },
                },
              }),
            ],
          }),
        },
        footers: {
          default: new Footer({
            children: [
              new Paragraph({
                alignment: AlignmentType.CENTER,
                border: {
                  top: { style: BorderStyle.SINGLE, size: 1, color: 'E2E8F0', space: 4 },
                },
                children: [
                  new TextRun({ text: 'Generated by Settle  ·  Page ', size: 16, color: '94A3B8', font: 'Arial' }),
                  new TextRun({ children: [PageNumber.CURRENT], size: 16, color: '94A3B8', font: 'Arial' }),
                  new TextRun({ text: ' of ', size: 16, color: '94A3B8', font: 'Arial' }),
                  new TextRun({ children: [PageNumber.TOTAL_PAGES], size: 16, color: '94A3B8', font: 'Arial' }),
                ],
              }),
            ],
          }),
        },
        children,
      },
    ],
  })

  return Buffer.from(await Packer.toBuffer(doc))
}

// ── Cover block ───────────────────────────────────────────────────────────────

function buildCoverBlock(data: RunbookData): DocChild[] {
  const formattedDate = (() => {
    try {
      return new Date(data.generatedAt).toLocaleDateString('en-US', {
        year: 'numeric',
        month: 'long',
        day: 'numeric',
      })
    } catch {
      return data.generatedAt
    }
  })()

  return [
    new Paragraph({ children: [], spacing: { before: 2400, after: 0 } }),
    new Paragraph({
      children: [new TextRun({ text: 'MIGRATION RUNBOOK', bold: true, size: 52, font: 'Arial', color: '1E293B' })],
      alignment: AlignmentType.CENTER,
      spacing: { before: 0, after: 200 },
    }),
    new Paragraph({
      children: [
        new TextRun({ text: `${data.sourceSystemName} → ${data.targetSystemName}`, size: 32, font: 'Arial', color: '4F46E5' }),
      ],
      alignment: AlignmentType.CENTER,
      spacing: { after: 160 },
    }),
    new Paragraph({
      children: [new TextRun({ text: data.projectName, size: 26, font: 'Arial', color: '334155' })],
      alignment: AlignmentType.CENTER,
      spacing: { after: 160 },
    }),
    new Paragraph({
      children: [new TextRun({ text: `Generated: ${formattedDate}`, size: 22, font: 'Arial', color: '64748B' })],
      alignment: AlignmentType.CENTER,
      spacing: { after: 400 },
    }),
    new Paragraph({
      children: [],
      border: { bottom: { style: BorderStyle.SINGLE, size: 3, color: 'E2E8F0', space: 1 } },
      spacing: { after: 240 },
    }),
    new Paragraph({
      children: [
        new TextRun({
          text: 'CONFIDENTIAL — For Migration Team Use Only  ·  Generated by Settle',
          size: 18,
          font: 'Arial',
          color: '94A3B8',
          italics: true,
        }),
      ],
      alignment: AlignmentType.CENTER,
      spacing: { after: 0 },
    }),
    new Paragraph({ children: [new PageBreak()] }),
  ]
}

// ── Heading builders ──────────────────────────────────────────────────────────

function buildH1(text: string): Paragraph {
  return new Paragraph({
    heading: HeadingLevel.HEADING_1,
    children: [new TextRun({ text, bold: true, size: 28, font: 'Arial', color: '1E293B' })],
    spacing: { before: 480, after: 200 },
    border: { bottom: { style: BorderStyle.SINGLE, size: 2, color: 'E2E8F0', space: 6 } },
  })
}

function buildH2(text: string): Paragraph {
  return new Paragraph({
    heading: HeadingLevel.HEADING_2,
    children: [new TextRun({ text, bold: true, size: 24, font: 'Arial', color: '334155' })],
    spacing: { before: 280, after: 120 },
  })
}

function buildH3(text: string): Paragraph {
  return new Paragraph({
    children: [new TextRun({ text, bold: true, size: 22, font: 'Arial', color: '475569' })],
    spacing: { before: 160, after: 80 },
  })
}

// ── Paragraph builders ────────────────────────────────────────────────────────

function para(text: string): Paragraph {
  return new Paragraph({
    children: [new TextRun({ text, font: 'Arial', size: 22 })],
    spacing: { after: 120 },
  })
}

function boldPara(text: string): Paragraph {
  return new Paragraph({
    children: [new TextRun({ text, bold: true, font: 'Arial', size: 22 })],
    spacing: { after: 120 },
  })
}

function grayPara(text: string): Paragraph {
  return new Paragraph({
    children: [new TextRun({ text, font: 'Arial', size: 18, color: '94A3B8', italics: true })],
    spacing: { after: 120 },
  })
}

function bullet(text: string): Paragraph {
  return new Paragraph({
    numbering: { reference: 'bullets', level: 0 },
    children: [new TextRun({ text, font: 'Arial', size: 22 })],
    spacing: { after: 80 },
  })
}

function spacer(): Paragraph {
  return new Paragraph({ children: [], spacing: { after: 200 } })
}

// ── Table builders ────────────────────────────────────────────────────────────

const cellBorder = { style: BorderStyle.SINGLE, size: 4, color: 'E2E8F0' }
const borders = { top: cellBorder, bottom: cellBorder, left: cellBorder, right: cellBorder }
const cellMargins = { top: 80, bottom: 80, left: 100, right: 100 }

/** 2-column label/value stats table. */
function buildStatsTable(rows: [string, string][]): Table {
  const colWidth = Math.floor(9360 / 2)

  const dataRows = rows.map(([label, value]) =>
    new TableRow({
      children: [
        new TableCell({
          borders,
          width: { size: colWidth, type: WidthType.DXA },
          margins: cellMargins,
          shading: { fill: 'F8FAFC', type: ShadingType.CLEAR, color: 'auto' },
          children: [
            new Paragraph({
              children: [new TextRun({ text: label, bold: true, font: 'Arial', size: 20, color: '334155' })],
            }),
          ],
        }),
        new TableCell({
          borders,
          width: { size: colWidth, type: WidthType.DXA },
          margins: cellMargins,
          children: [
            new Paragraph({
              children: [new TextRun({ text: value, font: 'Arial', size: 20 })],
            }),
          ],
        }),
      ],
    })
  )

  return new Table({
    width: { size: 9360, type: WidthType.DXA },
    columnWidths: [colWidth, colWidth],
    rows: dataRows,
  })
}

/** General table with header row and custom column widths. */
function buildFlexTable(
  headers: string[],
  rows: string[][],
  colWidths: number[]
): Table {
  const totalWidth = colWidths.reduce((a, b) => a + b, 0)

  const headerRow = new TableRow({
    tableHeader: true,
    children: headers.map((h, i) =>
      new TableCell({
        borders,
        width: { size: colWidths[i] ?? Math.floor(totalWidth / headers.length), type: WidthType.DXA },
        shading: { fill: 'F1F5F9', type: ShadingType.CLEAR, color: 'auto' },
        margins: cellMargins,
        children: [
          new Paragraph({
            children: [new TextRun({ text: h, bold: true, font: 'Arial', size: 20, color: '1E293B' })],
          }),
        ],
      })
    ),
  })

  const dataRows = rows.map((row) =>
    new TableRow({
      children: row.map((cell, i) =>
        new TableCell({
          borders,
          width: { size: colWidths[i] ?? Math.floor(totalWidth / headers.length), type: WidthType.DXA },
          margins: cellMargins,
          children: [
            new Paragraph({
              children: [new TextRun({ text: cell ?? '', font: 'Arial', size: 20 })],
            }),
          ],
        })
      ),
    })
  )

  return new Table({
    width: { size: totalWidth, type: WidthType.DXA },
    columnWidths: colWidths,
    rows: [headerRow, ...dataRows],
  })
}
