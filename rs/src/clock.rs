//! The time and the calendar, without a zone database.
//!
//! The TypeScript needs the calendar twice: `ls --dates` prints a UTC date,
//! and the call counter is kept per local day. JavaScript takes the local day
//! from the zone data built into its runtime (ICU, in bun), which is not the
//! data this machine has in /usr/share/zoneinfo: the two are of different
//! releases and disagree wherever a zone's rules changed in between. So the
//! binary works only with zones that are a fixed number of hours from UTC by
//! their very name, where there is nothing to look up (`env::startup` hands
//! every other machine back), and a date is plain arithmetic.

use std::time::{SystemTime, UNIX_EPOCH};

/// `Date.now()`
pub fn now_ms() -> Option<f64> {
    SystemTime::now().duration_since(UNIX_EPOCH).ok().map(|since| since.as_millis() as f64)
}

/// `new Date(ms).toISOString().slice(0, 10)` for the years 0000 to 9999.
pub fn utc_date(ms: f64) -> Option<String> {
    if !ms.is_finite() {
        return None;
    }
    let days = (ms.trunc() / 86_400_000.0).floor() as i64;
    // Civil date from days since 1970-01-01 (Howard Hinnant's algorithm).
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let day_of_era = z.rem_euclid(146_097);
    let year_of_era = (day_of_era - day_of_era / 1460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let shifted_month = (5 * day_of_year + 2) / 153;
    let day = day_of_year - (153 * shifted_month + 2) / 5 + 1;
    let month = if shifted_month < 10 { shifted_month + 3 } else { shifted_month - 9 };
    let year = year_of_era + era * 400 + i64::from(month <= 2);
    (0..=9999).contains(&year).then(|| format!("{year:04}-{month:02}-{day:02}"))
}

/// `localDateStr()` of src/index.ts at a moment, in a zone that is always
/// `minutes_east` of UTC: `YYYY-MM-DD` for the years 1000 to 9999 (the
/// TypeScript does not pad the year).
pub fn local_date(ms: f64, minutes_east: i32) -> Option<String> {
    utc_date(ms + f64::from(minutes_east) * 60_000.0).filter(|date| !date.starts_with('0'))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn utc_dates() {
        assert_eq!(utc_date(0.0).unwrap(), "1970-01-01");
        assert_eq!(utc_date(-1.0).unwrap(), "1969-12-31");
        assert_eq!(utc_date(951_782_400_000.0).unwrap(), "2000-02-29");
        assert_eq!(utc_date(1_709_251_199_999.0).unwrap(), "2024-02-29");
        assert_eq!(utc_date(253_402_300_799_999.0).unwrap(), "9999-12-31");
        assert_eq!(utc_date(253_402_300_800_000.0), None);
        assert_eq!(utc_date(-62_167_219_200_000.0).unwrap(), "0000-01-01");
        assert_eq!(utc_date(-62_167_219_200_001.0), None);
    }

    #[test]
    fn local_dates_in_fixed_zones() {
        // 2026-11-27 07:31 UTC
        let moment = 1_795_764_660_000.0;
        assert_eq!(local_date(moment, 0).unwrap(), "2026-11-27");
        assert_eq!(local_date(moment, -7 * 60).unwrap(), "2026-11-27");
        assert_eq!(local_date(moment, -8 * 60).unwrap(), "2026-11-26");
        assert_eq!(local_date(moment, -12 * 60).unwrap(), "2026-11-26");
        assert_eq!(local_date(moment, 14 * 60).unwrap(), "2026-11-27");
        assert_eq!(local_date(moment + 3.0 * 3_600_000.0, 14 * 60).unwrap(), "2026-11-28");
        // The last day of a year, and of February in a leap year.
        assert_eq!(local_date(1_798_761_599_000.0, 0).unwrap(), "2026-12-31");
        assert_eq!(local_date(1_798_761_599_000.0, 60).unwrap(), "2027-01-01");
        assert_eq!(local_date(1_835_481_600_000.0, -60).unwrap(), "2028-02-29");
        // A year the TypeScript would write with fewer than four digits.
        assert_eq!(local_date(-40_000_000_000_000.0, 0), None);
    }
}
