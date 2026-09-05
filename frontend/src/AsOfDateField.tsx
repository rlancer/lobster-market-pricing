import { DateInput } from '@astryxdesign/core/DateInput';
import { etDateString } from './tickerChartRange';
import { useAsOfDate } from './useAsOfDate';

type IsoDate = `${number}${number}${number}${number}-${number}${number}-${number}${number}`;

function asIsoDate(ymd: string): IsoDate {
  return ymd as IsoDate;
}

export function AsOfDateField({
  label = 'As of',
  description,
}: {
  label?: string;
  description?: string;
}) {
  const { asOf, setAsOf } = useAsOfDate();
  const today = etDateString();
  return (
    <DateInput
      label={label}
      description={description}
      size="sm"
      hasClear
      format="date"
      placeholder="Today"
      max={asIsoDate(today)}
      value={asOf ? asIsoDate(asOf) : undefined}
      onChange={(next) => setAsOf(next)}
      width={176}
    />
  );
}
