//! The time and the calendar, in one place.

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
}
