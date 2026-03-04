import { assertIsDefined } from 'test/helpers/asserts';
import type uPlot from 'uplot';

import {
  createDataFrame,
  createTheme,
  type DataFrame,
  FieldColorModeId,
  type FieldConfigSource,
  FieldType,
} from '@grafana/data';
import {
  AxisColorMode,
  AxisPlacement,
  defaultTimeZone,
  GraphGradientMode,
  LegendDisplayMode,
  MappingType,
  SortOrder,
  StackingMode,
  ThresholdsMode,
  TooltipDisplayMode,
  VisibilityMode,
  VizOrientation,
} from '@grafana/schema';
import { measureText, type UPlotConfigBuilder } from '@grafana/ui';

import type { BarsOptions } from './bars';
import * as barsModule from './bars';
import type { Options } from './panelcfg.gen';
import { applyBarChartFieldDefaults } from './test-helpers';
import { prepConfig, type PrepConfigOpts, prepSeries } from './utils';

const realMeasureText = jest.requireActual('@grafana/ui').measureText as typeof measureText;

jest.mock('@grafana/ui', () => {
  const actual = jest.requireActual('@grafana/ui');
  return {
    ...actual,
    // passthrough by default; the auto-spacing describe pins widths per test
    measureText: jest.fn(actual.measureText),
  };
});

jest.mock('@grafana/data', () => ({
  ...jest.requireActual('@grafana/data'),
  DefaultTimeZone: 'utc',
}));

describe('BarChart utils', () => {
  describe('preparePlotConfigBuilder', () => {
    it.each([VizOrientation.Auto, VizOrientation.Horizontal, VizOrientation.Vertical])('orientation', (v) => {
      const result = prepConfig(
        createPrepConfigOpts({
          options: { orientation: v },
          series: [createPreparedBarChartSeries()],
          orientation: v,
        })
      ).builder.getConfig();
      expect(result).toMatchSnapshot();
    });

    it.each([VisibilityMode.Always, VisibilityMode.Auto])('value visibility', (v) => {
      expect(
        prepConfig(
          createPrepConfigOpts({
            options: { showValue: v },
            series: [createPreparedBarChartSeries()],
          })
        ).builder.getConfig()
      ).toMatchSnapshot();
    });

    it.each([StackingMode.None, StackingMode.Percent, StackingMode.Normal])('stacking', (v) => {
      expect(
        prepConfig(
          createPrepConfigOpts({
            options: { stacking: v },
            series: [createPreparedBarChartSeries()],
          })
        ).builder.getConfig()
      ).toMatchSnapshot();
    });

    it('uses formatShortValue when xTickLabelMaxLength is set', () => {
      const longLabelFrame = createStringXFrame({
        xValues: ['verylonglabel1', 'verylonglabel2', 'verylonglabel3'],
        values: [10, 20, 30],
      });
      const info = prepBarChartSeries([longLabelFrame]);

      const result = prepConfig(
        createPrepConfigOpts({
          options: {
            orientation: VizOrientation.Vertical,
            xTickLabelMaxLength: 5,
          },
          orientation: VizOrientation.Vertical,
          series: info.series,
        })
      ).builder.getConfig();

      const xAxis = result.axes?.find((a) => a.scale === 'x');
      const xAxisValues = xAxis?.values;
      if (!xAxis || !isAxisValuesCallback(xAxisValues)) {
        throw new Error('Expected x axis with values function');
      }

      const splits = ['verylonglabel1', 'verylonglabel2', 'verylonglabel3'];
      // Invoke uPlot Axis.Values to verify formatShortValue shortens labels
      const labels = xAxisValues(null, splits, 0);

      expect(labels).toEqual(['veryl...', 'veryl...', 'veryl...']);
    });

    describe('getConfig spy', () => {
      beforeEach(() => {
        jest.restoreAllMocks();
      });

      it('sets groupWidth to barWidth and barWidth to 1 when single value field and stacking None', () => {
        const captured: { groupWidth: number; barWidth: number } = { groupWidth: 0, barWidth: 0 };
        withGetConfigSpy(
          (opts) => {
            captured.groupWidth = opts.groupWidth;
            captured.barWidth = opts.barWidth;
          },
          () => {
            const singleValueFrame = createStringXFrame();
            const info = prepBarChartSeries([singleValueFrame]);

            prepConfig(
              createPrepConfigOpts({
                options: { barWidth: 0.8, groupWidth: 0.6, stacking: StackingMode.None },
                series: info.series,
                totalSeries: 1,
              })
            ).builder.getConfig();
          }
        );

        expect(captured.groupWidth).toBe(0.8);
        expect(captured.barWidth).toBe(1);
      });

      it('sets getColor when color field is provided', () => {
        const captured: { getColor?: BarsOptions['getColor'] } = {};
        withGetConfigSpy(
          (opts) => {
            captured.getColor = opts.getColor;
          },
          () => {
            const df = createFrameWithColorField();
            const info = prepBarChartSeries([df], { colorFieldName: 'colorVal' });

            prepConfig(
              createPrepConfigOpts({
                color: info.color ?? undefined,
                series: info.series,
                totalSeries: 1,
              })
            ).builder.getConfig();
          }
        );

        const getColor = captured.getColor;
        if (!getColor) {
          throw new Error('Expected getColor to be defined');
        }
        const theme = createTheme();
        const expectedColors = {
          c0: theme.visualization.getColorByName('red'),
          c1: theme.visualization.getColorByName('green'),
          c2: theme.visualization.getColorByName('blue'),
        };
        expect(getColor(1, 0, 10)).toEqual(expectedColors.c0);
        expect(getColor(1, 1, 20)).toEqual(expectedColors.c1);
        expect(getColor(1, 2, 30)).toEqual(expectedColors.c2);
      });

      it('sets getColor from per-bar color when field has thresholds', () => {
        const captured: { getColor?: BarsOptions['getColor'] } = {};
        withGetConfigSpy(
          (opts) => {
            captured.getColor = opts.getColor;
          },
          () => {
            const df = createFrameWithThresholds({ values: [10, 50, 90] });
            const info = prepBarChartSeries([df]);
            prepConfig(
              createPrepConfigOpts({
                series: info.series,
                totalSeries: 1,
              })
            ).builder.getConfig();
          }
        );

        const getColor = captured.getColor;
        if (!getColor) {
          throw new Error('Expected getColor to be defined');
        }
        const c0 = getColor(1, 0, 10);
        const c1 = getColor(1, 1, 50);
        const c2 = getColor(1, 2, 90);
        expect(c0).toEqual('#73BF69');
        expect(c1).toEqual('#FADE2A');
        expect(c2).toEqual('#F2495C');
      });

      it('sets getColor from per-bar color when field has value mappings with colors', () => {
        const captured: { getColor?: BarsOptions['getColor'] } = {};
        withGetConfigSpy(
          (opts) => {
            captured.getColor = opts.getColor;
          },
          () => {
            const df = createFrameWithMappings({ values: [1, 2, 3] });
            const info = prepBarChartSeries([df]);
            prepConfig(
              createPrepConfigOpts({
                series: info.series,
                totalSeries: 1,
              })
            ).builder.getConfig();
          }
        );

        const getColor = captured.getColor;
        if (!getColor) {
          throw new Error('Expected getColor to be defined');
        }
        const c0 = getColor(1, 0, 1);
        const c1 = getColor(1, 1, 2);
        const c2 = getColor(1, 2, 3);
        expect(c0).toEqual('#73BF69');
        expect(c1).toEqual('#FADE2A');
        expect(c2).toEqual('#808080');
      });
    });

    it('calls setPadding when xTickLabelRotation is non-zero', () => {
      const frame = createPreparedBarChartSeries();
      const result = prepConfig(
        createPrepConfigOpts({
          options: {
            xTickLabelRotation: 45,
            xTickLabelMaxLength: 10,
          },
          series: [frame],
        })
      ).builder.getConfig();

      const padding = result.padding;
      expect(padding).toBeDefined();
      if (!padding) {
        throw new Error('Expected padding');
      }
      expect(padding).toHaveLength(4);
      // For positive rotation (45°), paddingRight (index 1) should be > 0 (cos(45°) * textWidth)
      expect(padding[1]).toBeGreaterThan(0);
    });

    it('hides x axis when axisPlacement is Hidden', () => {
      const result = getConfigFromAxisFrame(
        { xAxisPlacement: AxisPlacement.Hidden },
        { orientation: VizOrientation.Vertical }
      );

      const xAxis = result.axes?.find((a) => a.scale === 'x');
      expect(xAxis?.show).toBe(false);
    });

    it('swaps axis placement for Horizontal orientation', () => {
      const result = getConfigFromAxisFrame(
        {
          axisPlacement: AxisPlacement.Left,
          axisBorderShow: true,
          axisColorMode: AxisColorMode.Series,
          axisGridShow: true,
        },
        { orientation: VizOrientation.Horizontal }
      );

      const yAxis = result.axes?.find((a) => a.scale === 'short');
      expect(yAxis?.scale).toEqual('short');
      expect(yAxis?.side).toBe(2);
    });

    it('applies axisBorderShow and axisColorMode when set on field', () => {
      const result = getConfigFromAxisFrame(
        {
          axisPlacement: AxisPlacement.Left,
          axisBorderShow: true,
          axisColorMode: AxisColorMode.Series,
          axisGridShow: true,
        },
        { orientation: VizOrientation.Vertical }
      );

      const yAxis = result.axes?.find((a) => a.scale === 'short');
      expect(yAxis?.border?.show).toBe(true);
      expect(typeof yAxis?.stroke).toEqual('string');
      expect(yAxis?.grid?.show).toBe(true);
    });

    it('prepData closure updates internal state and delegates to builder.prepData', () => {
      const frame1 = createPreparedBarChartSeries();
      const { prepData } = prepConfig(
        createPrepConfigOpts({
          series: [frame1],
        })
      );

      expect(typeof prepData).toEqual('function');
      const prepDataFn = prepData;
      if (!prepDataFn) {
        throw new Error('prepData expected');
      }

      const newFrame = createStringXFrame({
        xValues: ['d', 'e', 'f'],
        values: [40, 50, 60],
      });

      const result = prepDataFn([newFrame], null);
      expect(Array.isArray(result)).toBe(true);
      expect(result).toHaveLength(2);
      // preparePlotData2 returns [xValues, yValues, ...] for each field; result[0]=x, result[1]=value
      expect(result[0]).toEqual(['d', 'e', 'f']);
      expect(result[1]).toEqual([40, 50, 60]);
    });
  });

  describe('prepareGraphableFrames', () => {
    it('will return empty string when there are no frames in the response', () => {
      const info = prepBarChartSeries([]);

      expect(info.warn).toBe('');
      expect(info.series).toHaveLength(0);
    });

    it('will return empty string when there is no data in the response', () => {
      const info = prepBarChartSeries([createEmptyFrame()]);

      expect(info.warn).toBe('');
      expect(info.series).toHaveLength(0);
    });

    it('will warn when there is no string or time field', () => {
      const df = createMutableFrame([
        { name: 'a', type: FieldType.other, values: [1, 2, 3, 4, 5] },
        { name: 'value', values: [1, 2, 3, 4, 5] },
      ]);

      const info = prepBarChartSeries([df]);
      const warning = assertIsDefined('warn' in info ? info : null);
      expect(warning.warn).toEqual('Bar charts require a string or time field');
    });

    it('will warn when there are no numeric fields in the response', () => {
      const df = createMutableFrame([
        { name: 'a', type: FieldType.string, values: ['a', 'b', 'c', 'd', 'e'] },
        { name: 'value', type: FieldType.boolean, values: [true, true, true, true, true] },
      ]);

      const info = prepBarChartSeries([df]);
      const warning = assertIsDefined('warn' in info ? info : null);
      expect(warning.warn).toEqual('No numeric fields found');
    });

    it('will convert NaN and Infinity to nulls', () => {
      const df = createMutableFrame([
        { name: 'a', type: FieldType.string, values: ['a', 'b', 'c', 'd', 'e'] },
        { name: 'value', values: [-10, NaN, 10, -Infinity, +Infinity] },
      ]);

      const info = prepBarChartSeries([df]);

      const field = info.series[0].fields[1];
      expect(field.values).toMatchInlineSnapshot(`
        [
          -10,
          null,
          10,
          null,
          null,
        ]
      `);
    });

    it('should not apply % unit to series when stacking is percent', () => {
      const df = createMutableFrame([
        { name: 'string', type: FieldType.string, values: ['a', 'b', 'c'] },
        { name: 'a', values: [-10, 20, 10], config: {} },
        { name: 'b', values: [20, 20, 20], config: {} },
        { name: 'c', values: [10, 10, 10], config: {} },
      ]);
      df.fields[1].state = { calcs: { min: -10 } };
      df.fields[2].state = { calcs: { min: 20 } };
      df.fields[3].state = { calcs: { min: 10 } };

      const info = prepBarChartSeries([df], { stacking: StackingMode.Percent });

      expect(info.series[0].fields[0].config.unit).toBeUndefined();
      expect(info.series[0].fields[1].config.unit).toBeUndefined();
      expect(info.series[0].fields[2].config.unit).toBeUndefined();
    });

    it('joins multiple frames on time field when frames have time and length > 1', () => {
      const df1 = createTimeXFrame({
        refId: 'A',
        timeValues: [1000, 2000, 3000],
        values: [10, 20, 30],
      });
      const df2 = createTimeXFrame({
        refId: 'B',
        timeValues: [1000, 2000, 4000],
        values: [5, 15, 25],
      });

      const info = prepBarChartSeries([df1, df2]);

      expect(info.series).toHaveLength(1);
      const frame = info.series[0];
      expect(frame.fields[0].type).toBe(FieldType.time);
      expect(frame.length).toEqual(4);
    });

    it('selects x field by xFieldName when provided', () => {
      const df = createFrameWithMultipleStringFields();

      const info = prepBarChartSeries([df], { xFieldName: 'other' });

      expect(info.series[0].fields[0].name).toBe('other');
      expect(info.series[0].fields[1].name).toBe('value');
    });

    it('selects color field by colorFieldName when provided', () => {
      const df = createFrameWithColorField({ colorFieldName: 'colorVal' });

      const info = prepBarChartSeries([df], { colorFieldName: 'colorVal' });

      expect(info.color).not.toBeNull();
      expect(info.color?.name).toBe('colorVal');
    });
  });

  describe('auto-spacing for time axis labels', () => {
    // Daily timestamps starting 2021-01-01 UTC
    const dayMs = 24 * 60 * 60 * 1000;
    const start = 1609459200000;

    type XAxisFilter = (u: uPlot, splits: number[]) => Array<number | null>;

    /** uPlot instance shape consumed by the axis filter callback. */
    interface FilterMockUPlot {
      data: number[][];
      bbox: { left: number; top: number; width: number; height: number };
    }

    /**
     * Casts FilterMockUPlot to uPlot for filter invocation.
     * Confines the type assertion to one place (mirrors asUPlot in bars.test.ts).
     */
    function asUPlot(u: FilterMockUPlot): uPlot {
      // @ts-expect-error incomplete mock satisfies only the axis-filter contract
      return u;
    }

    function mockUPlotFor(timestamps: number[], bboxWidth: number, bboxHeight: number): FilterMockUPlot {
      return { data: [timestamps], bbox: { left: 0, top: 0, width: bboxWidth, height: bboxHeight } };
    }

    const measureTextMock = jest.mocked(measureText);

    beforeEach(() => {
      measureTextMock.mockImplementation(realMeasureText);
    });

    afterEach(() => {
      measureTextMock.mockImplementation(realMeasureText);
    });

    /** Pins measured axis-label width so the auto-spacing math is deterministic. */
    function mockTimeLabelWidth(width: number): void {
      measureTextMock.mockReturnValue({ width } as unknown as ReturnType<typeof measureText>);
    }

    function extractXAxisFilter(
      df: DataFrame,
      opts: { xTickLabelSpacing?: number; orientation?: VizOrientation } = {}
    ): XAxisFilter | undefined {
      const info = prepBarChartSeries([df]);

      return prepConfig(
        createPrepConfigOpts({
          series: info.series,
          // Vertical bars draw the x-axis horizontally (label-width-driven spacing);
          // Auto resolves differently, so be explicit
          orientation: opts.orientation ?? VizOrientation.Vertical,
          options: { xTickLabelSpacing: opts.xTickLabelSpacing ?? 0 },
        })
      ).builder.getConfig().axes![0].filter as XAxisFilter | undefined;
    }

    it('keeps every tick when the chart is wide enough for all labels', () => {
      mockTimeLabelWidth(42);
      const timestamps = [start, start + dayMs, start + 2 * dayMs];
      const filter = extractXAxisFilter(createTimeXFrame({ timeValues: timestamps }))!;
      const u = asUPlot(mockUPlotFor(timestamps, 2000, 400));

      // 42px labels + 18px padding = 60px per tick; 2000px fits far more than 3 ticks
      expect(filter(u, [0, 1, 2])).toEqual([0, 1, 2]);
    });

    it('keeps exactly one tick on a narrow chart', () => {
      mockTimeLabelWidth(42);
      const timestamps = Array.from({ length: 30 }, (_, i) => start + i * dayMs);
      const filter = extractXAxisFilter(createTimeXFrame({ timeValues: timestamps }))!;
      const u = asUPlot(mockUPlotFor(timestamps, 100, 400));

      // 60px spacing leaves a single 100px slot → keep index 0, drop the rest
      const result = filter(
        u,
        timestamps.map((_, i) => i)
      );
      expect(result.filter((v) => v !== null)).toEqual([0]);
      // spacing derives from the label measured at UPLOT_AXIS_FONT_SIZE
      expect(measureTextMock).toHaveBeenCalledWith(expect.any(String), 12);
    });

    it('spaces vertical-axis ticks by font height rather than measured label width', () => {
      mockTimeLabelWidth(42);
      const timestamps = Array.from({ length: 20 }, (_, i) => start + i * dayMs);
      // Horizontal bars draw the x-axis vertically; bbox.height governs spacing
      const filter = extractXAxisFilter(createTimeXFrame({ timeValues: timestamps }), {
        orientation: VizOrientation.Horizontal,
      })!;
      const u = asUPlot(mockUPlotFor(timestamps, 400, 200));

      // 12px font + 8px padding = 20px per tick → 10 slots in 200px → keep every 2nd tick.
      // Width-based spacing (60px) would keep only 3, so this fails if the vertical
      // path reuses the horizontal logic.
      expect(
        filter(
          u,
          timestamps.map((_, i) => i)
        ).filter((v) => v !== null)
      ).toEqual([0, 2, 4, 6, 8, 10, 12, 14, 16, 18]);
    });

    it('honours user-configured xTickLabelSpacing without measuring labels', () => {
      mockTimeLabelWidth(999); // huge width proves the measurement is ignored
      const timestamps = Array.from({ length: 30 }, (_, i) => start + i * dayMs);
      const filter = extractXAxisFilter(createTimeXFrame({ timeValues: timestamps }), {
        xTickLabelSpacing: 50,
      })!;
      const u = asUPlot(mockUPlotFor(timestamps, 100, 400));

      // 50px spacing → two 100px slots → forward alignment keeps indices 0 and 15
      expect(
        filter(
          u,
          timestamps.map((_, i) => i)
        )
      ).toEqual([
        0,
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        15,
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        null,
      ]);
    });

    it('does not auto-space when the time field pins an explicit unit format', () => {
      const filter = extractXAxisFilter(createTimeXFrame({ xUnit: 'time:YYYY-MM-DD' }));
      expect(filter).toBeUndefined();
    });

    it('does not auto-space categorical string axes', () => {
      const filter = extractXAxisFilter(createStringXFrame());
      expect(filter).toBeUndefined();
    });

    it('keeps the only tick when there is a single data point', () => {
      mockTimeLabelWidth(42);
      const timestamps = [start];
      const filter = extractXAxisFilter(createTimeXFrame({ timeValues: timestamps }))!;
      const u = asUPlot(mockUPlotFor(timestamps, 400, 400));

      expect(filter(u, [0])).toEqual([0]);
    });
  });
});

// =============================================================================
// Constants, interfaces, and helper functions (grouped below test describe blocks)
// =============================================================================

/** Empty FieldConfigSource for bar chart tests. */
const EMPTY_FIELD_CONFIG: FieldConfigSource = {
  defaults: {},
  overrides: [],
};

/** Overrides for createStringXFrame. */
interface CreateStringXFrameOverrides {
  xValues?: string[];
  values?: number[];
  xConfig?: Record<string, unknown>;
  valueConfig?: Record<string, unknown>;
  refId?: string;
}

/** Overrides for createTimeXFrame. */
interface CreateTimeXFrameOverrides {
  timeValues?: number[];
  values?: number[];
  refId?: string;
  xUnit?: string;
}

/** Overrides for createFrameWithColorField. */
interface CreateFrameWithColorFieldOverrides {
  xValues?: string[];
  values?: number[];
  colorValues?: string[];
  colorFieldName?: string;
  colorMappings?: Array<{ value: string; text: string; color: string }>;
}

/** Overrides for createFrameWithThresholds. */
interface CreateFrameWithThresholdsOverrides {
  xValues?: string[];
  values?: number[];
  steps?: Array<{ value: number; color: string }>;
}

/** Overrides for createFrameWithMappings. */
interface CreateFrameWithMappingsOverrides {
  xValues?: string[];
  values?: number[];
  mappings?: Array<{ value: string; text: string; color: string }>;
}

/** Overrides for createFrameWithAxisConfig. */
interface CreateFrameWithAxisConfigOverrides {
  xValues?: string[];
  values?: number[];
  axisPlacement?: AxisPlacement;
  axisBorderShow?: boolean;
  axisColorMode?: AxisColorMode;
  axisGridShow?: boolean;
  xAxisPlacement?: AxisPlacement;
}

/** Options for prepBarChartSeries. */
interface PrepBarChartSeriesOptions {
  stacking?: StackingMode;
  xFieldName?: string;
  colorFieldName?: string;
}

/** Overrides for createPreparedBarChartSeries. */
interface CreatePreparedBarChartSeriesOverrides {
  xValues?: string[];
  values?: number[];
}

/** Overrides for createPrepConfigOpts. */
interface CreatePrepConfigOptsOverrides extends Omit<Partial<PrepConfigOpts>, 'options'> {
  options?: Partial<Options>;
}

/**
 * Creates a minimal bar chart DataFrame with x and value fields, then applies bar chart defaults.
 * Used as the base for createStringXFrame, createTimeXFrame, and other specialized frame builders.
 *
 * @param options - xField (name, type, values, config), valueField (values, config), and optional refId
 * @returns DataFrame with bar chart field defaults applied
 */
function createBaseBarChartFrame(options: {
  xField: { name: string; type: FieldType; values: unknown[]; config?: object };
  valueField: { values: number[]; config?: object };
  refId?: string;
}): DataFrame {
  const frame = createDataFrame({
    refId: options.refId,
    fields: [
      {
        name: options.xField.name,
        type: options.xField.type,
        values: options.xField.values,
        config: options.xField.config ?? { custom: {} },
      },
      {
        name: 'value',
        type: FieldType.number,
        values: options.valueField.values,
        config: options.valueField.config ?? { unit: 'short', custom: {} },
      },
    ],
  });
  applyBarChartFieldDefaults(frame);
  return frame;
}

/**
 * Creates a DataFrame with string x-axis and numeric value field for bar chart tests.
 * Applies bar chart field defaults (display processor, custom config).
 *
 * @param overrides - Optional overrides for x values, value array, field configs, and refId
 * @returns DataFrame ready for prepSeries/prepConfig
 */
function createStringXFrame(overrides?: CreateStringXFrameOverrides): DataFrame {
  const xValues = overrides?.xValues ?? ['a', 'b', 'c'];
  const values = overrides?.values ?? [10, 20, 30];
  const xConfig = overrides?.xConfig ?? { custom: {} };
  const valueConfig = overrides?.valueConfig ?? { unit: 'short', custom: {} };

  return createBaseBarChartFrame({
    refId: overrides?.refId,
    xField: { name: 'x', type: FieldType.string, values: xValues, config: xConfig },
    valueField: { values, config: valueConfig },
  });
}

/**
 * Creates a DataFrame with time-based x-axis and numeric values.
 * Used for tests that join multiple frames on time (e.g. prepareGraphableFrames).
 *
 * @param overrides - Optional time values, value array, and refId
 * @returns DataFrame with time + value fields
 */
function createTimeXFrame(overrides?: CreateTimeXFrameOverrides): DataFrame {
  const timeValues = overrides?.timeValues ?? [1000, 2000, 3000];
  const values = overrides?.values ?? [10, 20, 30];

  return createBaseBarChartFrame({
    refId: overrides?.refId,
    xField: {
      name: 'time',
      type: FieldType.time,
      values: timeValues,
      config: overrides?.xUnit ? { unit: overrides.xUnit, custom: {} } : { custom: {} },
    },
    valueField: { values, config: { unit: 'short', custom: {} } },
  });
}

/**
 * Builds a value-to-text mapping options object from an array of { value, text, color }.
 * Used by createFrameWithColorField and createFrameWithMappings.
 *
 * @param mappings - Array of value-to-text mappings with optional color
 * @returns Record keyed by value for MappingType.ValueToText options
 */
function buildValueToTextMappingOptions(
  mappings: Array<{ value: string; text: string; color: string }>
): Record<string, { text: string; color: string }> {
  const options: Record<string, { text: string; color: string }> = {};
  for (const m of mappings) {
    options[m.value] = { text: m.text, color: m.color };
  }
  return options;
}

/**
 * Creates a DataFrame with a string color field that has value-to-text mappings.
 * Used for tests that verify per-bar coloring from a discrete color field.
 *
 * @param overrides - Optional x values, values, color values, color field name, or custom mappings
 * @returns DataFrame with x, value, and color fields
 */
function createFrameWithColorField(overrides?: CreateFrameWithColorFieldOverrides): DataFrame {
  const xValues = overrides?.xValues ?? ['a', 'b', 'c'];
  const values = overrides?.values ?? [10, 20, 30];
  const colorValues = overrides?.colorValues ?? ['red', 'green', 'blue'];

  const colorMappings = overrides?.colorMappings ?? colorValues.map((v) => ({ value: v, text: v, color: v }));
  const colorOptions = buildValueToTextMappingOptions(colorMappings);

  const frame = createDataFrame({
    fields: [
      { name: 'x', type: FieldType.string, values: xValues, config: { custom: {} } },
      { name: 'value', type: FieldType.number, values, config: { unit: 'short', custom: {} } },
      {
        name: overrides?.colorFieldName ?? 'colorVal',
        type: FieldType.string,
        values: colorValues,
        config: {
          custom: { fillOpacity: 80 },
          mappings: [{ type: MappingType.ValueToText, options: colorOptions }],
        },
      },
    ],
  });
  applyBarChartFieldDefaults(frame);
  return frame;
}

/**
 * Creates a DataFrame with thresholds-based coloring on the value field.
 * Used for tests that verify per-bar colors from threshold steps.
 *
 * @param overrides - Optional x values, values, and threshold steps
 * @returns DataFrame with x and value fields (value has thresholds config)
 */
function createFrameWithThresholds(overrides?: CreateFrameWithThresholdsOverrides): DataFrame {
  const xValues = overrides?.xValues ?? ['a', 'b', 'c'];
  const values = overrides?.values ?? [10, 50, 90];
  const steps = overrides?.steps ?? [
    { value: 0, color: 'green' },
    { value: 50, color: 'yellow' },
    { value: 80, color: 'red' },
  ];

  const frame = createDataFrame({
    fields: [
      { name: 'x', type: FieldType.string, values: xValues, config: { custom: {} } },
      {
        name: 'value',
        type: FieldType.number,
        values,
        config: {
          unit: 'short',
          custom: {},
          color: { mode: FieldColorModeId.Thresholds },
          thresholds: {
            mode: ThresholdsMode.Absolute,
            steps: steps.map((s) => ({ value: s.value, color: s.color })),
          },
        },
      },
    ],
  });
  applyBarChartFieldDefaults(frame);
  return frame;
}

/**
 * Creates a DataFrame with value-to-text mappings (with colors) on the value field.
 * Used for tests that verify per-bar colors from value mappings.
 *
 * @param overrides - Optional x values, values, and mappings
 * @returns DataFrame with x and value fields (value has mappings config)
 */
function createFrameWithMappings(overrides?: CreateFrameWithMappingsOverrides): DataFrame {
  const xValues = overrides?.xValues ?? ['a', 'b', 'c'];
  const values = overrides?.values ?? [1, 2, 3];
  const mappings = overrides?.mappings ?? [
    { value: '1', text: 'Low', color: 'green' },
    { value: '2', text: 'Mid', color: 'yellow' },
  ];

  const options = buildValueToTextMappingOptions(mappings);

  const frame = createDataFrame({
    fields: [
      { name: 'x', type: FieldType.string, values: xValues, config: { custom: {} } },
      {
        name: 'value',
        type: FieldType.number,
        values,
        config: {
          unit: 'short',
          custom: {},
          mappings: [{ type: MappingType.ValueToText, options }],
        },
      },
    ],
  });
  applyBarChartFieldDefaults(frame);
  return frame;
}

/**
 * Creates a DataFrame with axis config overrides on x and/or value fields.
 * Used for tests that verify axis placement, border, color mode, and grid.
 *
 * @param overrides - Optional x values, values, axis placement, border, color mode, grid, x-axis placement
 * @returns DataFrame with axis config on fields
 */
function createFrameWithAxisConfig(overrides?: CreateFrameWithAxisConfigOverrides): DataFrame {
  const xValues = overrides?.xValues ?? ['a', 'b', 'c'];
  const values = overrides?.values ?? [10, 20, 30];

  const xConfig = overrides?.xAxisPlacement ? { custom: { axisPlacement: overrides.xAxisPlacement } } : { custom: {} };

  const valueCustom: Record<string, unknown> = {};
  if (overrides?.axisPlacement !== undefined) {
    valueCustom.axisPlacement = overrides.axisPlacement;
  }
  if (overrides?.axisBorderShow !== undefined) {
    valueCustom.axisBorderShow = overrides.axisBorderShow;
  }
  if (overrides?.axisColorMode !== undefined) {
    valueCustom.axisColorMode = overrides.axisColorMode;
  }
  if (overrides?.axisGridShow !== undefined) {
    valueCustom.axisGridShow = overrides.axisGridShow;
  }

  const frame = createDataFrame({
    fields: [
      { name: 'x', type: FieldType.string, values: xValues, config: xConfig },
      {
        name: 'value',
        type: FieldType.number,
        values,
        config: {
          unit: 'short',
          custom: Object.keys(valueCustom).length > 0 ? valueCustom : {},
        },
      },
    ],
  });
  applyBarChartFieldDefaults(frame);
  return frame;
}

/**
 * Creates a DataFrame with multiple string fields and one numeric value field.
 * Used for tests that select x field by name (xFieldName).
 *
 * @param overrides - Optional string fields and value field definitions
 * @returns DataFrame with label, other (or custom), and value fields
 */
function createFrameWithMultipleStringFields(overrides?: {
  stringFields?: Array<{ name: string; values: string[] }>;
  valueField?: { name: string; values: number[] };
}): DataFrame {
  const stringFields = overrides?.stringFields ?? [
    { name: 'label', values: ['x', 'y', 'z'] },
    { name: 'other', values: ['a', 'b', 'c'] },
  ];
  const valueField = overrides?.valueField ?? { name: 'value', values: [1, 2, 3] };

  const fields = [
    ...stringFields.map((f) => ({
      name: f.name,
      type: FieldType.string,
      values: f.values,
      config: { custom: {} },
    })),
    {
      name: valueField.name,
      type: FieldType.number,
      values: valueField.values,
      config: { custom: {} },
    },
  ];
  const frame = createDataFrame({ fields });
  applyBarChartFieldDefaults(frame);
  return frame;
}

/**
 * Creates an empty DataFrame with x and value fields (no rows).
 * Used for tests that verify empty-data handling.
 *
 * @returns Empty DataFrame with string x and number value fields
 */
function createEmptyFrame(): DataFrame {
  return createDataFrame({
    fields: [
      { name: 'x', type: FieldType.string, values: [], config: { custom: {} } },
      { name: 'value', type: FieldType.number, values: [], config: { custom: {} } },
    ],
  });
}

/**
 * Creates a DataFrame from an array of field definitions (minimal config).
 * Used for tests that need custom field types (e.g. other, boolean) or unusual structures.
 *
 * @param fields - Array of { name, type?, values, config? }
 * @returns DataFrame with the given fields (no bar chart defaults applied)
 */
function createMutableFrame(
  fields: Array<{ name: string; type?: FieldType; values: unknown[]; config?: Record<string, unknown> }>
): DataFrame {
  return createDataFrame({
    fields: fields.map((f) => ({
      name: f.name,
      type: f.type,
      values: f.values,
      config: { ...(f.config || {}), custom: f.config?.custom ?? {} },
    })),
  });
}

/**
 * Wrapper around prepSeries with EMPTY_FIELD_CONFIG and default theme.
 * Simplifies bar chart series preparation in tests.
 *
 * @param frames - DataFrames to prepare
 * @param opts - Optional stacking, xFieldName, colorFieldName
 * @returns Result of prepSeries (series, _rest, color, warn)
 */
function prepBarChartSeries(frames: DataFrame[], opts?: PrepBarChartSeriesOptions): ReturnType<typeof prepSeries> {
  return prepSeries(
    frames,
    EMPTY_FIELD_CONFIG,
    opts?.stacking ?? StackingMode.None,
    createTheme(),
    opts?.xFieldName,
    opts?.colorFieldName
  );
}

/**
 * Creates a prepared bar chart series (string x + value, passed through prepSeries).
 * Used as the default series for createPrepConfigOpts and many prepConfig tests.
 *
 * @param overrides - Optional x values and values
 * @returns Prepared DataFrame (first series from prepBarChartSeries)
 */
function createPreparedBarChartSeries(overrides?: CreatePreparedBarChartSeriesOverrides): DataFrame {
  const frame = createStringXFrame({
    xValues: overrides?.xValues ?? ['a', 'b', 'c'],
    values: overrides?.values ?? [10, 20, 30],
    valueConfig: {
      unit: 'm/s',
      custom: { lineWidth: 2, gradientMode: GraphGradientMode.Opacity },
    },
  });
  const info = prepBarChartSeries([frame]);
  if (info.series.length === 0) {
    throw new Error('Bar chart not prepared correctly');
  }
  return info.series[0];
}

/**
 * Creates PrepConfigOpts with sensible defaults for bar chart prepConfig tests.
 * Merges overrides for series, options, and other PrepConfigOpts fields.
 *
 * @param overrides - Optional series, options, totalSeries, orientation, etc.
 * @returns PrepConfigOpts ready for prepConfig
 */
function createPrepConfigOpts(overrides?: CreatePrepConfigOptsOverrides): PrepConfigOpts {
  const defaultOptions: Options = {
    orientation: VizOrientation.Auto,
    groupWidth: 20,
    barWidth: 2,
    showValue: VisibilityMode.Always,
    legend: {
      displayMode: LegendDisplayMode.List,
      showLegend: true,
      placement: 'bottom',
      calcs: [],
    },
    xTickLabelRotation: 0,
    xTickLabelMaxLength: 20,
    stacking: StackingMode.None,
    tooltip: {
      mode: TooltipDisplayMode.None,
      sort: SortOrder.None,
    },
    text: { valueSize: 10 },
    fullHighlight: false,
  };

  const baseSeries = createPreparedBarChartSeries();
  const { series: overridesSeries, options: overridesOptions, ...restOverrides } = overrides ?? {};

  return {
    totalSeries: 2,
    timeZone: defaultTimeZone,
    theme: createTheme(),
    orientation: VizOrientation.Auto,
    ...restOverrides,
    series: overridesSeries ?? [baseSeries],
    options: { ...defaultOptions, ...overridesOptions },
  };
}

/**
 * Builds prepConfig from a frame with axis config overrides, and returns the resulting uPlot config.
 * Convenience for axis-related tests (placement, border, color mode, grid).
 *
 * @param axisOverrides - Passed to createFrameWithAxisConfig
 * @param prepConfigOverrides - Overrides for createPrepConfigOpts (e.g. orientation)
 * @returns The uPlot config from builder.getConfig()
 */
function getConfigFromAxisFrame(
  axisOverrides: CreateFrameWithAxisConfigOverrides,
  prepConfigOverrides?: Partial<PrepConfigOpts>
): ReturnType<UPlotConfigBuilder['getConfig']> {
  const df = createFrameWithAxisConfig(axisOverrides);
  const info = prepBarChartSeries([df]);

  return prepConfig(
    createPrepConfigOpts({
      series: info.series,
      totalSeries: 1,
      ...prepConfigOverrides,
    })
  ).builder.getConfig();
}

/**
 * Type guard: narrows unknown to a callable axis values function.
 * Used to safely invoke uPlot Axis.Values without type assertions.
 */
function isAxisValuesCallback(v: unknown): v is (u: unknown, splits: string[], axisIdx: number) => string[] {
  return typeof v === 'function';
}

/**
 * Runs a test block with bars.getConfig spied on, allowing capture of BarsOptions passed to it.
 * Restores mocks after the callback.
 *
 * @param capture - Callback that receives the BarsOptions; store what you need in a closure/captured variable
 * @param testFn - Function that performs prepConfig and assertions
 */
function withGetConfigSpy(capture: (opts: BarsOptions) => void, testFn: () => void): void {
  const { getConfig: originalGetConfig } = jest.requireActual<typeof barsModule>('./bars');
  jest.spyOn(barsModule, 'getConfig').mockImplementation((opts: BarsOptions, theme) => {
    capture(opts);
    return originalGetConfig(opts, theme);
  });
  try {
    testFn();
  } finally {
    jest.restoreAllMocks();
  }
}
