import axios from "axios"

export interface CurveGauge {
    shortName: string;
    gauge: string;
}

export const getAllCurveGauges = async () => {
  const { data: resp } = await axios.get(
    "https://api.curve.fi/api/getAllGauges"
  );
  return Object.values(resp.data) as CurveGauge[];
};
