import axios from "axios"

export interface CurveGauge {
    shortName: string;
    gauge: string;
    rootGauge: string;
}

export const getAllCurveGauges = async () => {
    const {data: resp} = await axios.get("https://d3dl9x5bpp6us7.cloudfront.net/api/getAllGauges");
    return Object.values(resp.data) as CurveGauge[];
}