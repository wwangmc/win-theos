#import <UIKit/UIKit.h>

%config(generator=internal);

%hook UIViewController
- (void)viewDidAppear:(BOOL)animated {
    %orig;
    NSLog(@"Tweak hook ran in %@", NSBundle.mainBundle.bundleIdentifier);
}
%end
