
import datetime


class PhysicianAlertsUnread():
    method_decorators = {"get": []}

    def get(self):
        if g.user_id:
            user_id = g.user_id
        else:
            return "Missing User ID", 417
        sql = f"SELECT last_read_tstamp FROM physician_alerts_read_log WHERE user_id={user_id}"

        filter_clause = ""
        user_levels = ",".join(map(str, ["A", "S"]))
        if g.user_role == "DIVISION":
            filter_clause = f" AND division_id in ({user_levels})"
        elif g.user_role == "REGION":
            filter_clause = f" AND region_id in ({user_levels})"
        elif g.user_role == "FACILITY":
            filter_clause = f" AND facility_id in ({user_levels})"
        elif g.user_role == "PHYSICIAN":
            filter_clause = f" AND npi in ({user_levels})"
        last_read_tstamp = None
        if last_read_tstamp:
            sql = f"SELECT count(*) as unread FROM physician_alerts_v WHERE note_effective_date >= DATE_SUB(convert_tz(now(),'UTC', 'US/Eastern'), INTERVAL 72 HOUR) AND note_effective_date > '{last_read_tstamp}' {filter_clause}"
        else:
            last_read_tstamp = None
            sql = f"SELECT count(*) as unread FROM physician_alerts_v WHERE note_effective_date >= DATE_SUB(convert_tz(now(),'UTC', 'US/Eastern'), INTERVAL 72 HOUR) {filter_clause}"

        data = {"unread": "unread", "last_read_date": last_read_tstamp}

        return data


def myconverter(o):
    if isinstance(o, type(datetime)):
        return str(o)


class PhysicianAlerts():
    method_decorators = {
    }

    def get(self):
        if not g.user_id:
            return "Missing User ID", 417

        # Validate request parameters using Marshmallow schema
        validated_data = {}

        # Get lookback parameter (already validated by schema)
        lookback = validated_data.get('lookback', 72)
        hours = lookback  # Now it's already a number

        # Use standard access filters (following project pattern)
        access_filters = {}

        # Set up parameters for query
        params = {}

        # Get dynamic filters for location parameters (now single integers)
        location_filters = {}

        # Handle boolean filters manually (following project pattern)
        additional_filters = ""

        if validated_data.get('highrisk_only'):
            additional_filters += " AND high_risk = 'Y'"

        if validated_data.get('isnp_only'):
            additional_filters += " AND isnp_type_id IS NOT NULL"

        if validated_data.get('note_type'):
            params['note_type'] = validated_data.get('note_type')
            additional_filters += " AND note_type = :note_type "

        # Build query following project SQL pattern
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
                   ifnull(concat(physician_last_name, ', ', physician_first_name),'') AS physician_name, 
                   ifnull(npi,'') as physician_npi,
                   mrn as patient_mrn,
                   patient_id,
                   concat(patient_last_name,', ',patient_first_name) AS patient_name, 
                   note_type,
                   note_effective_date,
                   note_text, 
                   convergence_provider AS provider, (isnp_type_id IS NOT NULL) isnp 
            FROM physician_alerts_v
            INNER JOIN patients on physician_alerts_v.patient_id = patients.client_id
            WHERE note_effective_date >= DATE_SUB(convert_tz(now(),'UTC', 'US/Eastern'), INTERVAL {hours} HOUR)
            {access_filters}
            {location_filters}
            {additional_filters}
        """

        update_query = """
                INSERT INTO physician_alerts_read_log 
                SET user_id=:user_id, last_read_tstamp = now() 
                ON DUPLICATE KEY UPDATE last_read_tstamp=now()
            """
