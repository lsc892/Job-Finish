using System.Security;

internal static class ToastContent
{
    internal static string Build(string title, string message, string launch, string? imagePath)
    {
        var image = "";
        if (!string.IsNullOrWhiteSpace(imagePath) && Path.IsPathFullyQualified(imagePath) && File.Exists(imagePath))
        {
            var source = SecurityElement.Escape(new Uri(Path.GetFullPath(imagePath)).AbsoluteUri);
            image = $"<image placement=\"appLogoOverride\" hint-crop=\"none\" src=\"{source}\" alt=\"Notification icon\"/>";
        }
        // Windows allows four combined description lines; keep one title line.
        return $"<toast activationType=\"foreground\" launch=\"{SecurityElement.Escape(launch)}\"><visual><binding template=\"ToastGeneric\"><text hint-maxLines=\"1\">{SecurityElement.Escape(title)}</text><text hint-maxLines=\"4\">{SecurityElement.Escape(message)}</text>{image}</binding></visual><audio silent=\"true\"/></toast>";
    }
}
