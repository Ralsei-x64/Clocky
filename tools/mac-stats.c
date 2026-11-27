// Build from the project root using the command in README.md.
#include <CoreFoundation/CoreFoundation.h>
#include <IOKit/IOKitLib.h>
#include <IOKit/ps/IOPSKeys.h>
#include <IOKit/ps/IOPowerSources.h>
#include <mach/mach.h>
#include <math.h>
#include <stdbool.h>
#include <stdio.h>
#include <sys/sysctl.h>

static double number(CFDictionaryRef dict, CFStringRef key) {
    CFTypeRef value = CFDictionaryGetValue(dict, key);
    double result;
    if (value && CFGetTypeID(value) == CFNumberGetTypeID() &&
        CFNumberGetValue(value, kCFNumberDoubleType, &result)) return result;
    return NAN;
}

static double gpu_percent(void) {
    io_iterator_t iterator;
    if (IOServiceGetMatchingServices(MACH_PORT_NULL, IOServiceMatching("IOAccelerator"), &iterator)
        != KERN_SUCCESS) return NAN;
    double busiest = NAN;
    io_object_t device;
    while ((device = IOIteratorNext(iterator))) {
        CFTypeRef stats = IORegistryEntryCreateCFProperty(
            device, CFSTR("PerformanceStatistics"), kCFAllocatorDefault, 0);
        if (stats && CFGetTypeID(stats) == CFDictionaryGetTypeID()) {
            double utilization = number(stats, CFSTR("Device Utilization %"));
            if (!isfinite(utilization)) utilization = number(stats, CFSTR("GPU Activity(%)"));
            if (utilization >= 0 && utilization <= 100) busiest = fmax(busiest, utilization);
        }
        if (stats) CFRelease(stats);
        IOObjectRelease(device);
    }
    IOObjectRelease(iterator);
    return busiest;
}

static double memory_percent(void) {
    vm_statistics64_data_t vm;
    mach_msg_type_number_t count = HOST_VM_INFO64_COUNT;
    vm_size_t page_size;
    uint64_t total;
    size_t size = sizeof(total);
    mach_port_t host = mach_host_self();
    bool ok = host_page_size(host, &page_size) == KERN_SUCCESS &&
        host_statistics64(host, HOST_VM_INFO64, (host_info64_t)&vm, &count) == KERN_SUCCESS;
    mach_port_deallocate(mach_task_self(), host);
    if (!ok || sysctlbyname("hw.memsize", &total, &size, NULL, 0) || !total) return NAN;
    double pages = fmax(0, (double)vm.internal_page_count - vm.purgeable_count)
        + vm.wire_count + vm.compressor_page_count;
    return fmin(100, 100 * pages * page_size / total);
}

static double battery_percent(bool *charging, bool *plugged_in) {
    CFTypeRef snapshot = IOPSCopyPowerSourcesInfo();
    if (!snapshot) return NAN;
    CFArrayRef list = IOPSCopyPowerSourcesList(snapshot);
    double percent = NAN;
    for (CFIndex i = 0; list && i < CFArrayGetCount(list); i++) {
        CFDictionaryRef source = IOPSGetPowerSourceDescription(snapshot, CFArrayGetValueAtIndex(list, i));
        if (!source) continue;
        CFTypeRef type = CFDictionaryGetValue(source, CFSTR(kIOPSTypeKey));
        if (!type || !CFEqual(type, CFSTR(kIOPSInternalBatteryType))) continue;
        double current = number(source, CFSTR(kIOPSCurrentCapacityKey));
        double maximum = number(source, CFSTR(kIOPSMaxCapacityKey));
        if (maximum > 0 && current >= 0) percent = 100 * current / maximum;
        *charging = CFDictionaryGetValue(source, CFSTR(kIOPSIsChargingKey)) == kCFBooleanTrue;
        CFTypeRef state = CFDictionaryGetValue(source, CFSTR(kIOPSPowerSourceStateKey));
        *plugged_in = state && CFEqual(state, CFSTR(kIOPSACPowerValue));
        break;
    }
    if (list) CFRelease(list);
    CFRelease(snapshot);
    return percent;
}

static void print_percent(double value) {
    if (isfinite(value) && value >= 0 && value <= 100) printf("%.0f", value);
    else fputs("null", stdout);
}

int main(void) {
    bool charging = false, plugged_in = false;
    double battery = battery_percent(&charging, &plugged_in);
    fputs("{\"ram\":", stdout);
    print_percent(memory_percent());
    fputs(",\"gpu\":", stdout);
    print_percent(gpu_percent());
    fputs(",\"battery\":", stdout);
    print_percent(battery);
    printf(",\"charging\":%s,\"pluggedIn\":%s}\n",
        charging ? "true" : "false", plugged_in ? "true" : "false");
    return 0;
}
