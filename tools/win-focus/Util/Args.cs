// 책임: CLI 인자와 URI 쿼리 파싱 유틸.
internal static class Args
{
    internal static string? GetArg(string[] args, string name)
    {
        for (var i = 0; i < args.Length - 1; i++)
        {
            if (string.Equals(args[i], name, StringComparison.OrdinalIgnoreCase))
            {
                return args[i + 1];
            }
        }
        return null;
    }

    internal static bool HasFlag(string[] args, string name)
    {
        return args.Any(arg => string.Equals(arg, name, StringComparison.OrdinalIgnoreCase));
    }

    internal static bool IsTruthy(string? value)
    {
        if (value is null) return false;
        return value.Length == 0
            || string.Equals(value, "1", StringComparison.OrdinalIgnoreCase)
            || string.Equals(value, "true", StringComparison.OrdinalIgnoreCase)
            || string.Equals(value, "yes", StringComparison.OrdinalIgnoreCase);
    }

    // jobfinish-focus:// URI를 Uri로 파싱해 쿼리 값을 꺼내되, 파싱이 실패하면 name= 마커 기반의 경량 파서로 폴백한다.
    internal static string? GetQueryValue(string? uri, string name)
    {
        if (string.IsNullOrWhiteSpace(uri)) return null;
        try
        {
            var parsed = new Uri(uri);
            var query = parsed.Query.TrimStart('?').Split('&', StringSplitOptions.RemoveEmptyEntries);
            foreach (var pair in query)
            {
                var parts = pair.Split('=', 2);
                if (parts.Length == 2 && string.Equals(Uri.UnescapeDataString(parts[0]), name, StringComparison.OrdinalIgnoreCase))
                {
                    return Uri.UnescapeDataString(parts[1].Replace("+", "%20"));
                }
            }
        }
        catch
        {
            // Fall through to the lightweight parser below.
        }

        var marker = name + "=";
        var index = uri.IndexOf(marker, StringComparison.OrdinalIgnoreCase);
        if (index < 0) return null;
        var value = uri[(index + marker.Length)..];
        var amp = value.IndexOf('&');
        if (amp >= 0) value = value[..amp];
        return Uri.UnescapeDataString(value.Replace("+", "%20"));
    }

    internal static long? TryParseLong(string? value)
    {
        return long.TryParse(value, out var parsed) ? parsed : null;
    }

    internal static int? TryParseInt(string? value)
    {
        return int.TryParse(value, out var parsed) ? parsed : null;
    }
}
