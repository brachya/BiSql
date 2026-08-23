hours = 1
access_filters = "AND access_filters"
location_filters = "AND location_filters"
additional_filters = "AND additional_filters"

query = f"""
    SELECT
        pn_id,
        high_risk,
        division_name,
        division_id,
        region_name,
        region_id,
        facility_id,
        facility_name,
        ifnull(
            concat(physician_last_name, ', ', physician_first_name),
            ''
        ) AS physician_name,
        ifnull(npi, '') AS physician_npi,
        mrn AS patient_mrn,
        patient_id,
        concat(patient_last_name, ', ', patient_first_name) AS patient_name,
        note_type,
        note_effective_date,
        note_text,
        convergence_provider AS provider,
        (isnp_type_id IS NOT NULL) isnp
    FROM
        physician_alerts_v
        INNER JOIN patients ON physician_alerts_v.patient_id = patients.client_id
    WHERE
        note_effective_date >= DATE_SUB(
            convert_tz(now(), 'UTC', 'US/Eastern'),
            INTERVAL {hours} HOUR
        ) {access_filters} {location_filters} {additional_filters}
"""
